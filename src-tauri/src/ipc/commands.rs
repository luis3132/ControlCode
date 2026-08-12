//! Despacho de los comandos de la CLI.
//!
//! Cada comando se resuelve por el camino más corto posible:
//!
//! - **Lecturas** (`*.list`, `tab output`, `workspace status`) van directo a SQLite o al
//!   registro de PTYs, sin molestar al frontend.
//! - **Acciones sobre ventanas/workspaces/skills** reusan los mismos comandos Tauri que
//!   usa la UI, así la CLI nunca toma un camino distinto al de un click.
//! - **Crear/cerrar tabs** pasa por `bridge`, porque mientras la app corre la fuente de
//!   verdad de las tabs es el store del frontend (ver el comentario de ese módulo).

use super::bridge::{ask_frontend, unwrap_frontend_result};
use super::protocol::{arg_str, arg_str_opt, arg_u64_opt, Response};
use crate::database::DbConnection;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub fn dispatch(app: &AppHandle, command: &str, args: &Value) -> Response {
    let result = match command {
        "tab.list" => tab_list(app),
        "tab.output" => tab_output(app, args),
        "tab.send" => tab_send(app, args),
        "tab.create" => tab_create(app, args),
        "tab.close" => bridge_call(app, "tab.close", args),
        "agent.list" => agent_list(app),
        "account.list" => account_list(app),
        "prelaunch.list" => prelaunch_list(app),
        "watch.add" => watch_add(app, args),
        "watch.remove" => watch_remove(app, args),
        "watch.list" => watch_list(app),
        "watch.wait" => watch_wait(args),
        "window.list" => window_list(app),
        "window.create" => window_create(app),
        "workspace.list" => workspace_list(app),
        "workspace.open" => workspace_open(app, args),
        "workspace.status" => workspace_status(app),
        "skill.list" => skill_list(app),
        "skill.install" => skill_install(app, args),
        "app.status" => app_status(app),
        other => Err(format!("Comando desconocido: {other}")),
    };

    match result {
        Ok(data) => Response::ok(data),
        Err(e) => Response::err(e),
    }
}

fn db(app: &AppHandle) -> Result<tauri::State<'_, DbConnection>, String> {
    app.try_state::<DbConnection>().ok_or_else(|| "La base de datos no está lista".to_string())
}

fn bridge_call(app: &AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    let window = arg_str_opt(args, "window");
    let raw = ask_frontend(app, command, args, window.as_deref())?;
    unwrap_frontend_result(raw)
}

// ── Tabs ─────────────────────────────────────────────────────────

/// Tabs de todas las ventanas ABIERTAS, con el id de PTY vivo si lo tienen. Las tabs de
/// ventanas cerradas (workspaces guardados) no se listan: para la CLI, "las tabs" son las
/// que están corriendo ahora.
fn tab_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.agent_id, t.agent_label, t.command, t.cwd, t.session_id,
                    w.label, w.workspace_id, t.tab_order
             FROM tabs t JOIN windows w ON w.id = t.window_id
             WHERE w.is_open = 1
             ORDER BY w.label ASC, t.tab_order ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, Option<String>>(1)?,
                "agentId": r.get::<_, String>(2)?,
                "agentLabel": r.get::<_, String>(3)?,
                "command": r.get::<_, String>(4)?,
                "cwd": r.get::<_, String>(5)?,
                "sessionId": r.get::<_, Option<String>>(6)?,
                "window": r.get::<_, String>(7)?,
                "workspaceId": r.get::<_, String>(8)?,
                "order": r.get::<_, i64>(9)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({ "tabs": rows }))
}

/// El id de PTY no está en SQLite (es efímero, vive en memoria mientras el proceso
/// corre), así que hay que pedírselo al frontend, que es quien lo tiene asociado a su tab.
///
/// `window` importa: cada ventana solo conoce SUS tabs. Sin pasarlo, una tab creada con
/// `--window` se buscaba siempre en la primera ventana y "no existía".
fn pty_id_for_tab(app: &AppHandle, tab_id: &str, window: Option<&str>) -> Result<u32, String> {
    let raw = ask_frontend(app, "tab.ptyId", &json!({ "tabId": tab_id }), window)?;
    let value = unwrap_frontend_result(raw)?;
    value
        .get("ptyId")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| format!("La tab {tab_id} no tiene un proceso corriendo"))
}

/// Igual, pero esperando: una tab recién creada todavía no tiene PTY (lo abre el frontend
/// al montar la terminal, un par de ciclos después de responder "creada").
fn wait_for_pty(app: &AppHandle, tab_id: &str, window: Option<&str>) -> Result<u32, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    const POLL: std::time::Duration = std::time::Duration::from_millis(200);

    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        if let Ok(pty_id) = pty_id_for_tab(app, tab_id, window) {
            return Ok(pty_id);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "La tab {tab_id} se creó pero su proceso no arrancó en {}s",
                TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(POLL);
    }
}

/// Crea una tab y, si se pidió, le manda un prompt inicial ya confirmado.
///
/// Las dos cosas que hace además de delegar en el frontend:
///
/// 1. **Traduce nombres de skills a ids.** El usuario escribe `--skills git-helper`, pero
///    `attach_skill` necesita el id (un UUID). Se resuelve acá, que es donde está la base,
///    y así el error puede decir qué hay instalado en vez de fallar sin explicación.
/// 2. **Espera a que la TUI esté lista antes de escribirle.** Mandar el prompt apenas
///    aparece el PTY no funciona: los agentes tardan en levantar y descartan lo que llega
///    mientras tanto. Ver `wait_until_ready`.
fn tab_create(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let window = arg_str_opt(args, "window");
    let prompt = init_prompt(args);

    // Los ids resueltos reemplazan a los nombres antes de cruzar el puente.
    let mut forwarded = args.clone();
    if let Some(requested) = skill_names(args) {
        let ids = resolve_skill_ids(app, &requested)?;
        forwarded["skills"] = json!(ids);
    }
    // `--account trabajo` → el id de esa cuenta. Se resuelve acá, contra la base, para
    // poder FALLAR con un motivo: una cuenta inexistente que se ignore en silencio abre la
    // tab con la cuenta equivocada, que es el peor resultado posible — parece que funcionó.
    if let Some(name) = arg_str_opt(args, "account") {
        let agent = arg_str_opt(args, "agent").unwrap_or_default();
        forwarded["accountId"] = json!(resolve_account_id(app, &agent, &name)?);
    }
    // `--pre "..."` / `--pre-preset nombre` → la cadena ya con ids. Mismo criterio que con
    // las cuentas: un preset inexistente falla acá y no lanza la tab, porque arrancar sin
    // el entorno que se pidió es peor que no arrancar.
    if let Some(steps) = args.get("prelaunch").and_then(|v| v.as_array()) {
        forwarded["prelaunch"] = json!(resolve_prelaunch_steps(app, steps)?);
    }

    let created = bridge_call(app, "tab.create", &forwarded)?;

    let Some(prompt) = prompt else { return Ok(created) };
    let tab_id = created
        .get("tabId")
        .and_then(|v| v.as_str())
        .ok_or("La tab se creó pero no devolvió su id")?
        .to_string();

    let pty_id = wait_for_pty(app, &tab_id, window.as_deref())?;
    let ready = wait_until_ready(pty_id);
    submit_prompt(pty_id, &prompt)?;

    let mut out = created;
    out["promptSent"] = json!(true);
    // Si se agotó la espera igual se manda: es mejor que abandonar, pero el llamador tiene
    // que poder enterarse de que quizá la TUI no estaba escuchando todavía.
    out["promptWaitedForReady"] = json!(ready);
    Ok(out)
}

/// `--initprompt` y `--init-prompt` llegan como claves distintas (el parser de la CLI
/// pasa los guiones a camelCase). Se aceptan las dos: son el mismo flag para el usuario.
fn init_prompt(args: &Value) -> Option<String> {
    arg_str_opt(args, "initPrompt")
        .or_else(|| arg_str_opt(args, "initprompt"))
        .filter(|p| !p.trim().is_empty())
}

fn skill_names(args: &Value) -> Option<Vec<String>> {
    let raw = args.get("skills")?.as_array()?;
    let names: Vec<String> =
        raw.iter().filter_map(|v| v.as_str()).map(str::to_string).collect();
    (!names.is_empty()).then_some(names)
}

/// Nombre (o id) → id de skill instalada. Case-insensitive, porque escribir el nombre
/// exacto de memoria en una terminal es pedir demasiado.
fn resolve_skill_ids(app: &AppHandle, requested: &[String]) -> Result<Vec<String>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;

    let mut installed: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, name FROM skills").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        installed.extend(rows.filter_map(|r| r.ok()));
    }

    match_skill_ids(&installed, requested)
}

/// El emparejamiento en sí, sobre `(id, name)` ya leídos. Separado para poder probarlo.
fn match_skill_ids(
    installed: &[(String, String)],
    requested: &[String],
) -> Result<Vec<String>, String> {
    requested
        .iter()
        .map(|wanted| {
            let needle = wanted.to_lowercase();
            installed
                .iter()
                .find(|(id, name)| id.to_lowercase() == needle || name.to_lowercase() == needle)
                .map(|(id, _)| id.clone())
                .ok_or_else(|| {
                    let names: Vec<&str> = installed.iter().map(|(_, n)| n.as_str()).collect();
                    if names.is_empty() {
                        format!("No hay ninguna skill instalada, así que '{wanted}' no existe. Instalá una con 'ccode skill install --skill <nombre>'")
                    } else {
                        format!("No hay ninguna skill instalada llamada '{wanted}'. Instaladas: {}", names.join(", "))
                    }
                })
        })
        .collect()
}

/// Espera a que la TUI deje de escribir por `quiet`, hasta un máximo de `max`.
///
/// No hay forma portable de preguntarle a un proceso "¿ya estás listo?", y una espera fija
/// o se queda corta con un agente lento o desperdicia segundos con uno rápido. El silencio
/// es la mejor señal disponible: es la misma idea que el evento `idle` del modo push.
///
/// `require_output` distingue los dos usos: al arrancar, "todavía no escribió nada" NO es
/// silencio, es que no arrancó; después de escribirle un prompt, una TUI que no repinta
/// nada sí cuenta como quieta.
///
/// Devuelve `false` si se agotó el tiempo (o si el proceso murió).
fn wait_until_quiet(
    pty_id: u32,
    quiet: std::time::Duration,
    max: std::time::Duration,
    require_output: bool,
) -> bool {
    const POLL: std::time::Duration = std::time::Duration::from_millis(100);

    let deadline = std::time::Instant::now() + max;
    let mut last_total = crate::terminal::output_total(pty_id).unwrap_or(0);
    let mut quiet_since: Option<std::time::Instant> = None;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(POLL);
        let Some(total) = crate::terminal::output_total(pty_id) else {
            return false;
        };

        if total != last_total {
            last_total = total;
            quiet_since = None;
            continue;
        }
        if require_output && total == 0 {
            continue;
        }
        match quiet_since {
            Some(since) if since.elapsed() >= quiet => return true,
            Some(_) => {}
            None => quiet_since = Some(std::time::Instant::now()),
        }
    }
    false
}

/// Espera a que la TUI termine de arrancar.
fn wait_until_ready(pty_id: u32) -> bool {
    wait_until_quiet(
        pty_id,
        std::time::Duration::from_millis(700),
        std::time::Duration::from_secs(25),
        true,
    )
}

/// Escribe un prompt en una TUI y lo confirma con Enter.
///
/// **El Enter va en una escritura aparte, y después de que la TUI se aquietó.** Mandarlo
/// pegado al texto (`"{prompt}\r"`, que es lo que se hacía antes) no envía nada: los
/// agentes con caja de texto multilínea reciben todo en el mismo chunk del PTY y tratan
/// ese CR como un salto de línea DENTRO del prompt, no como "enviar". El prompt queda
/// escrito y ahí se queda.
///
/// Separarlo reproduce lo que hace una persona: escribir, ver el texto aparecer, y recién
/// entonces apretar Enter. El silencio entre medio es lo que garantiza que llegue en una
/// lectura distinta, incluso si la TUI tarda en repintar.
fn submit_prompt(pty_id: u32, text: &str) -> Result<(), String> {
    const ECHO_QUIET: std::time::Duration = std::time::Duration::from_millis(250);
    const ECHO_MAX: std::time::Duration = std::time::Duration::from_secs(5);

    crate::terminal::write_to_pty(pty_id, text)?;
    wait_until_quiet(pty_id, ECHO_QUIET, ECHO_MAX, false);
    crate::terminal::write_to_pty(pty_id, "\r")
}

// ── Agentes ──────────────────────────────────────────────────────

/// Qué se puede pasar en `--agent`: los detectados en el PATH más las TUIs que el usuario
/// registró a mano. Sin esto, el id correcto había que adivinarlo.
/// Cuentas de una TUI, tal como las guarda `accounts`.
fn accounts_of(app: &AppHandle) -> Result<Vec<(String, String, String)>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, agent_id, name FROM agent_accounts ORDER BY agent_id, name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Nombre de cuenta → id, comprobando que sea de ESE agente.
///
/// Que sea del agente correcto no es un detalle: los perfiles no son intercambiables (cada
/// TUI usa su propia variable de entorno), así que abrir Claude con la cuenta de OpenCode
/// no daría un error visible — daría una tab que ignora la cuenta en silencio.
fn resolve_account_id(app: &AppHandle, agent_id: &str, name: &str) -> Result<String, String> {
    match_account_id(&accounts_of(app)?, agent_id, name)
}

/// El emparejamiento en sí, sobre las cuentas ya leídas. Separado para poder probarlo.
fn match_account_id(
    accounts: &[(String, String, String)],
    agent_id: &str,
    name: &str,
) -> Result<String, String> {
    let needle = name.to_lowercase();
    let of_agent: Vec<&(String, String, String)> =
        accounts.iter().filter(|(_, a, _)| a == agent_id).collect();

    if let Some((id, _, _)) = of_agent
        .iter()
        .find(|(id, _, n)| n.to_lowercase() == needle || id.to_lowercase() == needle)
    {
        return Ok(id.clone());
    }

    // Una cuenta que existe pero es de otra TUI es el error más fácil de cometer, así que
    // se distingue de "no existe" en vez de dar el mismo mensaje genérico.
    if let Some((_, otro, _)) = accounts
        .iter()
        .find(|(_, _, n)| n.to_lowercase() == needle)
    {
        return Err(format!(
            "La cuenta '{name}' es de '{otro}', no de '{agent_id}'"
        ));
    }

    let names: Vec<&str> = of_agent.iter().map(|(_, _, n)| n.as_str()).collect();
    if names.is_empty() {
        Err(format!(
            "'{agent_id}' no tiene ninguna cuenta creada. Se crean desde Configuración › Cuentas; 'ccode accounts' las lista"
        ))
    } else {
        Err(format!(
            "'{agent_id}' no tiene ninguna cuenta llamada '{name}'. Tiene: {}",
            names.join(", ")
        ))
    }
}

/// Comandos de pre-lanzamiento guardados: qué se puede poner en `--pre-preset`.
fn prelaunch_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, command FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "command": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let presets: Vec<Value> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    Ok(json!({ "presets": presets }))
}

/// Convierte los pasos que mandó la CLI en los que entiende el frontend
/// (`{"command":…}` / `{"presetId":…}`), conservando el orden.
///
/// Tres formas de entrada, y cada una existe por algo:
///
/// - `{"pre":…}` — lo que manda `--pre`. **Ambiguo a propósito**: el usuario escribe una
///   sola cosa y acá se decide si era el nombre de un guardado o un comando literal. La
///   resolución vive de este lado porque es donde está la base.
/// - `{"presetName":…}` — `--pre-preset`. Exige que exista; sirve cuando un guardado se
///   llama igual que un comando que querés correr tal cual.
/// - `{"command":…}` — literal siempre. Es lo que llega por `--json-args`.
fn resolve_prelaunch_steps(app: &AppHandle, steps: &[Value]) -> Result<Vec<Value>, String> {
    let presets = prelaunch_presets(app)?;
    steps
        .iter()
        .map(|step| {
            if let Some(cmd) = step.get("command").and_then(|v| v.as_str()) {
                return Ok(json!({ "command": cmd }));
            }
            if let Some(text) = step.get("pre").and_then(|v| v.as_str()) {
                // Un guardado con ese nombre gana sobre el literal: si el usuario se tomó
                // el trabajo de guardarlo, escribirlo es pedirlo.
                return Ok(match match_preset_id(&presets, text) {
                    Ok(id) => json!({ "presetId": id }),
                    Err(_) => json!({ "command": text }),
                });
            }
            let name = step
                .get("presetName")
                .and_then(|v| v.as_str())
                .ok_or("Paso de pre-lanzamiento sin comando ni nombre de guardado")?;
            Ok(json!({ "presetId": match_preset_id(&presets, name)? }))
        })
        .collect()
}

/// `(id, nombre)` de los comandos guardados.
fn prelaunch_presets(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Nombre de preset → id. Separado de la lectura para poder probarlo.
fn match_preset_id(presets: &[(String, String)], name: &str) -> Result<String, String> {
    let needle = name.trim().to_lowercase();
    if let Some((id, _)) = presets.iter().find(|(_, n)| n.to_lowercase() == needle) {
        return Ok(id.clone());
    }
    if presets.is_empty() {
        return Err(format!(
            "No hay ningún comando de pre-lanzamiento guardado llamado '{name}'. \
             Se crean en Configuración → Pre-lanzamiento."
        ));
    }
    let names: Vec<&str> = presets.iter().map(|(_, n)| n.as_str()).collect();
    Err(format!(
        "No existe un comando de pre-lanzamiento llamado '{name}'. Hay: {}",
        names.join(", ")
    ))
}

/// Cuentas creadas, agrupadas por TUI. La cuenta principal no se lista: no es una cuenta
/// gestionada por la app, es "no pasar `--account`".
fn account_list(app: &AppHandle) -> Result<Value, String> {
    let accounts: Vec<Value> = accounts_of(app)?
        .into_iter()
        .map(|(id, agent_id, name)| json!({ "id": id, "agent": agent_id, "name": name }))
        .collect();
    Ok(json!({ "accounts": accounts }))
}

fn agent_list(app: &AppHandle) -> Result<Value, String> {
    let detected = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(crate::agents::detect_agents())?;

    let db = db(app)?;
    let custom = crate::agents::list_custom_agents(db)?;

    let builtin: Vec<Value> = detected
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "label": a.label,
                "command": a.command,
                "available": a.available,
                "version": a.version,
                "custom": false,
            })
        })
        .collect();

    let custom: Vec<Value> = custom
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "label": a.label,
                "command": a.command,
                // Una TUI custom la declaró el usuario: se asume disponible, la app no
                // sale a comprobar si su binario está en el PATH.
                "available": true,
                "custom": true,
                "resumable": a.resume_args.is_some(),
            })
        })
        .collect();

    let agents = [builtin, custom].concat();
    Ok(json!({ "agents": agents }))
}

/// Cuántas líneas de cola devuelve `tab output` por defecto. Antes eran 200 líneas crudas;
/// con la salida ya comprimida, 40 líneas útiles dicen más y cuestan una fracción.
const DEFAULT_TAIL_LINES: usize = 40;

/// Salida de una tab, comprimida para que la lea un modelo (Fase 9).
///
/// Dos cosas la diferencian de devolver el scrollback:
///
/// 1. **Solo lo nuevo.** Cada llamada arranca donde terminó la anterior. Releer una tab
///    que no escribió nada devuelve vacío en vez de reenviar las mismas 200 líneas — que
///    era la forma más fácil de agotar el contexto sin enterarse.
/// 2. **Señales, no transcripción.** Errores y warnings se extraen del texto COMPLETO
///    (aunque hayan quedado fuera de la cola) y el resto se colapsa (ver `orchestrator::digest`).
///
/// Escotillas: `--full` ignora el cursor y digiere todo el scrollback vivo; `--raw`
/// devuelve las últimas `--lines` líneas sin comprimir, para cuando el modelo necesita ver
/// el texto exacto.
fn tab_output(app: &AppHandle, args: &Value) -> Result<Value, String> {
    use crate::orchestrator::digest;

    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;

    let (scrollback, total_bytes) = crate::terminal::scrollback_of(pty_id)
        .ok_or_else(|| format!("La tab {tab_id} no tiene salida disponible"))?;

    let full = args.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
    let raw_mode = args.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);
    let tail_lines = arg_u64_opt(args, "lines").unwrap_or(DEFAULT_TAIL_LINES as u64) as usize;

    if raw_mode {
        // El crudo no mueve el cursor: es una inspección puntual, no "leer lo nuevo".
        let all: Vec<&str> = scrollback.lines().collect();
        let start = all.len().saturating_sub(tail_lines);
        return Ok(json!({
            "tabId": tab_id,
            "mode": "raw",
            "lines": all[start..],
            "truncated": start > 0,
            "totalLines": all.len(),
        }));
    }

    let (text, scope, lost) = if full {
        // `--full` deja igual el cursor puesto al día, para que la siguiente llamada
        // vuelva a devolver solo lo nuevo.
        let out = crate::orchestrator::new_output_for(&tab_id, &scrollback, total_bytes);
        (scrollback.clone(), "full", out.lost)
    } else {
        let out = crate::orchestrator::new_output_for(&tab_id, &scrollback, total_bytes);
        let scope = if out.first_read { "full" } else { "new" };
        (out.text, scope, out.lost)
    };

    let d = digest::digest(&text, tail_lines);

    Ok(json!({
        "tabId": tab_id,
        "mode": "digest",
        // `new` = solo lo que llegó desde la lectura anterior; `full` = todo el scrollback
        // vivo (primera lectura de esta tab, o `--full`).
        "scope": scope,
        "errors": d.errors,
        "warnings": d.warnings,
        "tail": d.tail,
        // `true` si parte de la salida se perdió: el proceso escribió más de lo que cabe
        // en el scrollback y lo más viejo ya no existe.
        "lost": lost,
        "truncated": d.kept_lines > d.tail.len(),
        "summary": {
            "rawLines": d.raw_lines,
            "keptLines": d.kept_lines,
            "estimatedTokens": digest::estimate_tokens(&d.tail.concat()),
        },
    }))
}

// ── Modo push (watch) ────────────────────────────────────────────

fn watch_limit(app: &AppHandle) -> Result<usize, String> {
    let db = db(app)?;
    Ok(crate::orchestrator::watch_limit(&db))
}

fn watch_add(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;
    let idle = arg_u64_opt(args, "idle").unwrap_or(crate::orchestrator::watch::DEFAULT_IDLE_SECS);
    let limit = watch_limit(app)?;

    crate::orchestrator::watch::add(pty_id, &tab_id, idle, limit)?;
    crate::orchestrator::emit_stats(app);

    Ok(json!({ "tabId": tab_id, "watching": true, "idleSecs": idle, "limit": limit }))
}

fn watch_remove(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let removed = crate::orchestrator::watch::remove_tab(&tab_id);
    if !removed {
        return Err(format!("La tab {tab_id} no estaba siendo observada"));
    }
    crate::orchestrator::forget_cursor(&tab_id);
    crate::orchestrator::emit_stats(app);
    Ok(json!({ "tabId": tab_id, "watching": false }))
}

fn watch_list(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "watched": crate::orchestrator::watch::list(),
        "limit": watch_limit(app)?,
    }))
}

/// Bloquea hasta que alguna tab observada tenga algo que contar. Es lo que reemplaza al
/// polling: la llamada duerme en el backend (que no gasta contexto) en vez de que el
/// modelo relea tabs cada N segundos (que sí gasta).
fn watch_wait(args: &Value) -> Result<Value, String> {
    /// Tope duro para no dejar una conexión colgada indefinidamente si el llamador pide
    /// un timeout absurdo.
    const MAX_TIMEOUT_SECS: u64 = 3600;

    if crate::orchestrator::watch::count() == 0 {
        return Err(
            "No hay ninguna tab observada. Agregá una con 'ccode watch add --tab <id>'".to_string(),
        );
    }

    let timeout = arg_u64_opt(args, "timeout").unwrap_or(300).min(MAX_TIMEOUT_SECS);
    let max = arg_u64_opt(args, "max").unwrap_or(20) as usize;

    let events = crate::orchestrator::watch::wait(std::time::Duration::from_secs(timeout), max);
    Ok(json!({
        "events": events,
        // Sin esto, "no pasó nada" y "se venció el timeout" se ven igual desde la CLI.
        "timedOut": events.is_empty(),
    }))
}

fn tab_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let text = arg_str(args, "text")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;

    // Por defecto se manda Enter al final: "send" en una TUI interactiva casi siempre
    // significa "escribí esto y confirmá". `--no-enter` sirve para mandar teclas sueltas
    // (Escape, Ctrl-C) o para dejar el prompt escrito sin enviarlo, y ahí el texto va
    // crudo: separar el Enter no aplica porque no hay Enter.
    if args.get("noEnter").and_then(|v| v.as_bool()).unwrap_or(false) {
        crate::terminal::write_to_pty(pty_id, &text)?;
    } else {
        submit_prompt(pty_id, &text)?;
    }

    Ok(json!({ "tabId": tab_id, "sent": true }))
}

// ── Ventanas ─────────────────────────────────────────────────────

fn window_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT w.label, w.workspace_id, ws.name, COUNT(t.id)
             FROM windows w
             LEFT JOIN workspaces ws ON ws.id = w.workspace_id
             LEFT JOIN tabs t ON t.window_id = w.id
             WHERE w.is_open = 1
             GROUP BY w.id ORDER BY w.label ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "label": r.get::<_, String>(0)?,
                "workspaceId": r.get::<_, String>(1)?,
                "workspaceName": r.get::<_, Option<String>>(2)?,
                "tabCount": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({ "windows": rows }))
}

fn window_create(app: &AppHandle) -> Result<Value, String> {
    // Mismo esquema de label que usa el resto de la app para ventanas nuevas: único a
    // nivel de proceso, que es lo único que Tauri exige.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let label = format!("cc-window-{millis}");

    let app = app.clone();
    let label_for_task = label.clone();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(crate::window::open_new_window(app, label_for_task))?;

    Ok(json!({ "label": label, "created": true }))
}

// ── Workspaces ───────────────────────────────────────────────────

fn workspace_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let rows = crate::database::db_list_workspaces(db)?;
    Ok(json!({ "workspaces": rows }))
}

fn workspace_open(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let requested = arg_str(args, "workspace")?;
    let close_current = args.get("closeCurrent").and_then(|v| v.as_bool()).unwrap_or(false);

    // Se acepta el id o el nombre: desde una terminal, escribir el nombre es lo natural.
    let id = {
        let db = db(app)?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM workspaces WHERE id = ?1 OR name = ?1",
            [&requested],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No existe el workspace '{requested}'"))?
    };

    // `open_workspace` es `async` pero su cuerpo no espera nada que necesite el runtime
    // de Tauri; se corre en un runtime propio para no exigirle un contexto async al hilo
    // del servidor IPC.
    let app = app.clone();
    let id_for_task = id.clone();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(crate::window::open_workspace(app, id_for_task, close_current))?;

    Ok(json!({ "workspaceId": id, "opened": true }))
}

/// Foto de qué está abierto ahora: workspaces vivos con sus ventanas y tabs. Es lo que un
/// agente orquestador necesita leer una vez para orientarse.
fn workspace_status(app: &AppHandle) -> Result<Value, String> {
    let windows = window_list(app)?;
    let tabs = tab_list(app)?;
    Ok(json!({
        "windows": windows.get("windows").cloned().unwrap_or(Value::Null),
        "tabs": tabs.get("tabs").cloned().unwrap_or(Value::Null),
    }))
}

// ── Skills ───────────────────────────────────────────────────────

/// Skills instaladas (lo que se le puede pasar a `--skills`) y lo disponible en los repos.
///
/// La forma es deliberadamente flaca: la fila completa de una skill trae fechas, rutas,
/// versiones compatibles y su uso por workspace — nada de eso ayuda a decidir cuál
/// adjuntar, y este listado lo lee un modelo que paga por cada campo (Fase 9). Para el
/// detalle completo está la UI.
fn skill_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;

    let rows = crate::skills::list_skills(db.clone())?;
    let installed_names: std::collections::HashSet<String> =
        rows.iter().map(|s| s.skill.name.to_lowercase()).collect();

    let installed: Vec<Value> = rows
        .iter()
        .map(|s| {
            json!({
                "name": s.skill.name,
                "description": s.skill.description,
                "version": s.skill.version,
                "agents": s.skill.compatible_agents,
                // Cuántos workspaces/tabs la tienen adjuntada ahora mismo.
                "attachedTo": s.used_by.len(),
            })
        })
        .collect();

    // Lo ya instalado se saca de "available": repetirlo sería devolver dos veces la misma
    // skill con distinta forma, y la lista de repos es la más larga de las dos.
    let available: Vec<Value> = crate::marketplace::list_marketplace_skills(None, None, db)?
        .iter()
        .filter(|e| !installed_names.contains(&e.name.to_lowercase()))
        .map(|e| json!({ "name": e.name, "description": e.description, "registry": e.registry_name }))
        .collect();

    Ok(json!({ "installed": installed, "available": available }))
}

fn skill_install(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let skill = arg_str(args, "skill")?;
    let db = db(app)?;

    // Se busca la skill por nombre o id entre lo que ofrecen los repos habilitados. Un
    // nombre ambiguo (dos repos con la misma skill) resuelve al de mayor prioridad, que
    // es el mismo criterio que usa el marketplace en la UI.
    let entries = crate::marketplace::list_marketplace_skills(None, None, db.clone())?;
    let wanted = skill.to_lowercase();
    let entry = entries
        .into_iter()
        .find(|e| e.name.to_lowercase() == wanted || e.id.to_lowercase() == wanted)
        .ok_or_else(|| {
            // El nombre puede venir de la lista `installed` de `ccode skills`, donde no
            // hay nada que instalar. Decir "no se encontró en los repos" ahí sería
            // desconcertante: la skill existe, ya la tiene.
            let already = crate::skills::list_skills(db.clone())
                .map(|rows| rows.iter().any(|s| s.skill.name.to_lowercase() == wanted))
                .unwrap_or(false);
            if already {
                format!("'{skill}' ya está instalada; podés usarla directo en --skills")
            } else {
                format!("No se encontró '{skill}' en los repositorios habilitados (mirá 'ccode skills' o refrescá los repos)")
            }
        })?;

    let registry_id = entry.registry_id.clone();
    let skill_id = entry.id.clone();
    let installed = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(crate::marketplace::install_marketplace_skill(registry_id, skill_id, db))?;

    Ok(json!({ "installed": installed }))
}

// ── App ──────────────────────────────────────────────────────────

fn app_status(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "version": app.package_info().version.to_string(),
        "protocol": super::protocol::PROTOCOL_VERSION,
        "windows": app.webview_windows().len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::match_preset_id;

    fn presets() -> Vec<(String, String)> {
        vec![
            ("p1".into(), "entorno conda".into()),
            ("p2".into(), "node del proyecto".into()),
        ]
    }

    #[test]
    fn el_nombre_del_preset_no_distingue_mayusculas() {
        assert_eq!(match_preset_id(&presets(), "Entorno Conda").unwrap(), "p1");
        assert_eq!(match_preset_id(&presets(), "  entorno conda  ").unwrap(), "p1");
    }

    /// El error tiene que decir qué SÍ existe: quien escribió mal un nombre no debería
    /// tener que ir a la UI a mirarlo.
    #[test]
    fn un_preset_inexistente_lista_los_que_hay() {
        let err = match_preset_id(&presets(), "conda").unwrap_err();
        assert!(err.contains("entorno conda"), "{err}");
        assert!(err.contains("node del proyecto"), "{err}");
    }

    /// El texto de `--pre` se resuelve contra los guardados y, si no coincide con ninguno,
    /// se ejecuta tal cual. Es lo que deja pasar las dos cosas por un solo flag.
    #[test]
    fn pre_usa_el_guardado_si_el_nombre_coincide() {
        assert_eq!(match_preset_id(&presets(), "entorno conda").unwrap(), "p1");
    }

    #[test]
    fn pre_cae_a_comando_literal_si_no_hay_guardado_con_ese_nombre() {
        // No es un error: `--pre "nvm use"` sin nada guardado tiene que correr `nvm use`.
        assert!(match_preset_id(&presets(), "nvm use").is_err());
    }

    #[test]
    fn sin_presets_guardados_el_error_dice_donde_crearlos() {
        let err = match_preset_id(&[], "conda").unwrap_err();
        assert!(err.contains("Configuración"), "{err}");
    }


    /// Cuentas de prueba: `(id, agente, nombre)`, como salen de `agent_accounts`.
    fn accounts() -> Vec<(String, String, String)> {
        vec![
            ("a1".into(), "claude-code".into(), "trabajo".into()),
            ("a2".into(), "claude-code".into(), "personal".into()),
            ("a3".into(), "opencode".into(), "trabajo".into()),
        ]
    }

    #[test]
    fn an_account_resolves_by_name_within_its_own_agent() {
        assert_eq!(match_account_id(&accounts(), "claude-code", "trabajo").unwrap(), "a1");
        // Mismo nombre, otra TUI: son cuentas distintas.
        assert_eq!(match_account_id(&accounts(), "opencode", "trabajo").unwrap(), "a3");
    }

    #[test]
    fn an_account_also_resolves_by_id_and_ignoring_case() {
        assert_eq!(match_account_id(&accounts(), "claude-code", "A1").unwrap(), "a1");
        assert_eq!(match_account_id(&accounts(), "claude-code", "Personal").unwrap(), "a2");
    }

    /// El error más fácil de cometer, y el que en silencio abriría la tab con la cuenta
    /// del sistema: pedir una cuenta que existe pero es de otra TUI.
    #[test]
    fn an_account_of_another_agent_is_rejected_by_name() {
        let err = match_account_id(&accounts(), "opencode", "personal").unwrap_err();
        assert!(err.contains("es de 'claude-code'"), "{err}");
    }

    #[test]
    fn an_unknown_account_lists_the_ones_that_exist() {
        let err = match_account_id(&accounts(), "claude-code", "qa").unwrap_err();
        assert!(err.contains("trabajo") && err.contains("personal"), "{err}");
    }

    /// Con un nombre que no existe en ninguna TUI se explica dónde se crean. Ojo: para un
    /// nombre que SÍ existe en otra TUI gana el mensaje de arriba, que dice más.
    #[test]
    fn an_agent_without_accounts_says_where_to_create_them() {
        let err = match_account_id(&accounts(), "codex", "qa").unwrap_err();
        assert!(err.contains("no tiene ninguna cuenta creada"), "{err}");
    }

    use super::*;

    fn installed() -> Vec<(String, String)> {
        vec![
            ("11111111-aaaa".to_string(), "git-helper".to_string()),
            ("22222222-bbbb".to_string(), "Testing Pro".to_string()),
        ]
    }

    /// `--skills` toma NOMBRES, que es lo único que un humano (o un agente) puede escribir:
    /// el id es un UUID. Pasarlos derecho a `attach_skill` no adjuntaba nada.
    #[test]
    fn skill_names_resolve_to_their_ids() {
        let got = match_skill_ids(&installed(), &["git-helper".to_string()]).unwrap();
        assert_eq!(got, vec!["11111111-aaaa"]);
    }

    #[test]
    fn matching_ignores_case_and_accepts_the_id_directly() {
        let requested = vec!["TESTING pro".to_string(), "11111111-aaaa".to_string()];
        let got = match_skill_ids(&installed(), &requested).unwrap();
        assert_eq!(got, vec!["22222222-bbbb", "11111111-aaaa"]);
    }

    /// Un nombre inventado tiene que fallar diciendo qué SÍ hay: la alternativa era una
    /// tab creada en silencio sin las skills que se pidieron.
    #[test]
    fn an_unknown_skill_names_the_installed_ones() {
        let err = match_skill_ids(&installed(), &["no-existe".to_string()]).unwrap_err();
        assert!(err.contains("no-existe"));
        assert!(err.contains("git-helper") && err.contains("Testing Pro"));
    }

    #[test]
    fn with_nothing_installed_the_error_says_how_to_install() {
        let err = match_skill_ids(&[], &["git-helper".to_string()]).unwrap_err();
        assert!(err.contains("skill install"), "el error tiene que decir el próximo paso: {err}");
    }

    /// Las dos grafías del flag son el mismo para el usuario, y un prompt en blanco no
    /// debería disparar toda la espera de arranque para no mandar nada.
    #[test]
    fn the_init_prompt_flag_accepts_both_spellings_and_ignores_blanks() {
        assert_eq!(init_prompt(&json!({ "initprompt": "hola" })).as_deref(), Some("hola"));
        assert_eq!(init_prompt(&json!({ "initPrompt": "hola" })).as_deref(), Some("hola"));
        assert_eq!(init_prompt(&json!({ "initPrompt": "   " })), None);
        assert_eq!(init_prompt(&json!({})), None);
    }

    #[test]
    fn skill_names_are_read_from_the_array_the_cli_sends() {
        assert_eq!(
            skill_names(&json!({ "skills": ["a", "b"] })),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(skill_names(&json!({ "skills": [] })), None);
        assert_eq!(skill_names(&json!({})), None);
    }
}
