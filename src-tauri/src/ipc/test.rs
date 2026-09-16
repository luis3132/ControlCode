//! Tests del IPC: el formato del cable, la resolución de nombres que hace la CLI y la
//! instalación del binario.

use serde_json::json;

use super::commands::{
    init_prompt, match_account_id, match_preset_id, match_skill_ids, skill_names, InstalledSkill,
};
use super::install::{is_installed, target_dir};
use super::protocol::{arg_str, Handshake, Request, Response, PROTOCOL_VERSION};

// ── Formato del cable ───────────────────────────────────────────

/// El handshake y las requests son el contrato entre dos binarios que se compilan juntos
/// pero corren por separado: tienen que sobrevivir el ida y vuelta. Y `args` es opcional —
/// un comando sin flags no debería tener que mandar un objeto vacío explícito.
#[test]
fn el_formato_del_cable_sobrevive_el_ida_y_vuelta() {
    let hs = Handshake { port: 45123, token: "tok".into(), pid: 42, protocol: PROTOCOL_VERSION };
    let back: Handshake = serde_json::from_str(&serde_json::to_string(&hs).unwrap()).unwrap();
    assert_eq!(back.port, 45123);
    assert_eq!(back.token, "tok");
    assert_eq!(back.protocol, PROTOCOL_VERSION);

    let req = Request {
        token: "tok".into(),
        command: "tab.create".into(),
        args: json!({ "cwd": "/repo", "skills": ["a", "b"] }),
    };
    let back: Request = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
    assert_eq!(back.command, "tab.create");
    assert_eq!(back.args["skills"][1], "b");

    let sin_args: Request =
        serde_json::from_str(r#"{"token":"t","command":"tab.list"}"#).unwrap();
    assert!(sin_args.args.is_null());
}

/// Las respuestas omiten el campo que no aplica, para que la CLI pueda distinguir
/// "sin datos" de "hubo error" sin mirar `ok`.
#[test]
fn las_respuestas_omiten_el_campo_que_no_aplica() {
    let ok = serde_json::to_string(&Response::ok(json!({ "tabs": [] }))).unwrap();
    assert!(ok.contains("\"data\""));
    assert!(!ok.contains("\"error\""));

    let err = serde_json::to_string(&Response::err("no existe")).unwrap();
    assert!(err.contains("\"error\":\"no existe\""));
    assert!(!err.contains("\"data\""));
}

#[test]
fn un_argumento_faltante_nombra_el_flag_que_se_olvido() {
    let err = arg_str(&json!({}), "cwd").unwrap_err();
    assert_eq!(err, "Falta el argumento --cwd");
    assert_eq!(arg_str(&json!({ "cwd": "/x" }), "cwd").unwrap(), "/x");
}

// ── Resolución de nombres ───────────────────────────────────────

fn presets() -> Vec<(String, String)> {
    vec![("p1".into(), "entorno conda".into()), ("p2".into(), "node del proyecto".into())]
}

/// El texto de `--pre` se resuelve contra los guardados sin distinguir mayúsculas ni
/// espacios de más; si no coincide con ninguno se ejecuta tal cual.
#[test]
fn el_nombre_del_preset_se_resuelve_sin_distinguir_mayusculas() {
    assert_eq!(match_preset_id(&presets(), "Entorno Conda").unwrap(), "p1");
    assert_eq!(match_preset_id(&presets(), "  entorno conda  ").unwrap(), "p1");
    assert!(match_preset_id(&presets(), "nvm use").is_err(), "sin coincidencia, es literal");
}

/// El error tiene que decir qué SÍ existe: quien escribió mal un nombre no debería
/// tener que ir a la UI a mirarlo. Y sin nada guardado, dónde crearlos.
#[test]
fn un_preset_inexistente_lista_los_que_hay() {
    let err = match_preset_id(&presets(), "conda").unwrap_err();
    assert!(err.contains("entorno conda"), "{err}");
    assert!(err.contains("node del proyecto"), "{err}");

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

/// Una cuenta se resuelve por nombre o por id, sin distinguir mayúsculas, y siempre
/// dentro de SU TUI: el mismo nombre en otra TUI es otra cuenta.
#[test]
fn una_cuenta_se_resuelve_dentro_de_su_propia_tui() {
    assert_eq!(match_account_id(&accounts(), "claude-code", "trabajo").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "opencode", "trabajo").unwrap(), "a3");
    assert_eq!(match_account_id(&accounts(), "claude-code", "A1").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "claude-code", "Personal").unwrap(), "a2");
}

/// El error más fácil de cometer, y el que en silencio abriría la tab con la cuenta
/// del sistema: pedir una cuenta que existe pero es de otra TUI.
#[test]
fn una_cuenta_de_otro_agente_se_rechaza_por_nombre() {
    let err = match_account_id(&accounts(), "opencode", "personal").unwrap_err();
    assert!(err.contains("es de 'claude-code'"), "{err}");
}

/// Un nombre desconocido lista las que hay; si esa TUI no tiene ninguna, explica dónde
/// se crean.
#[test]
fn una_cuenta_desconocida_explica_que_opciones_existen() {
    let err = match_account_id(&accounts(), "claude-code", "qa").unwrap_err();
    assert!(err.contains("trabajo") && err.contains("personal"), "{err}");

    let err = match_account_id(&accounts(), "codex", "qa").unwrap_err();
    assert!(err.contains("no tiene ninguna cuenta creada"), "{err}");
}

fn skill(id: &str, name: &str, author: Option<&str>, registry: Option<&str>) -> InstalledSkill {
    InstalledSkill {
        id: id.to_string(),
        name: name.to_string(),
        author: author.map(str::to_string),
        registry_name: registry.map(str::to_string),
    }
}

fn installed() -> Vec<InstalledSkill> {
    vec![
        skill("11111111-aaaa", "git-helper", None, None),
        skill("22222222-bbbb", "Testing Pro", None, None),
    ]
}

/// `--skills` toma NOMBRES, que es lo único que un humano (o un agente) puede escribir:
/// el id es un UUID. Pasarlos derecho a `attach_skill` no adjuntaba nada.
#[test]
fn los_nombres_de_skill_se_resuelven_a_sus_ids() {
    assert_eq!(
        match_skill_ids(&installed(), &["git-helper".to_string()]).unwrap(),
        vec!["11111111-aaaa"]
    );

    let requested = vec!["TESTING pro".to_string(), "11111111-aaaa".to_string()];
    assert_eq!(
        match_skill_ids(&installed(), &requested).unwrap(),
        vec!["22222222-bbbb", "11111111-aaaa"],
        "sin distinguir mayúsculas, y el id derecho también vale"
    );
}

/// Un nombre inventado tiene que fallar diciendo qué SÍ hay: la alternativa era una
/// tab creada en silencio sin las skills que se pidieron.
#[test]
fn una_skill_desconocida_nombra_las_instaladas() {
    let err = match_skill_ids(&installed(), &["no-existe".to_string()]).unwrap_err();
    assert!(err.contains("no-existe"));
    assert!(err.contains("git-helper") && err.contains("Testing Pro"));

    let err = match_skill_ids(&[], &["git-helper".to_string()]).unwrap_err();
    assert!(err.contains("skill install"), "el error tiene que decir el próximo paso: {err}");
}

/// Las dos grafías del flag son el mismo para el usuario, y un prompt en blanco no
/// debería disparar toda la espera de arranque para no mandar nada.
#[test]
fn el_flag_del_prompt_inicial_acepta_las_dos_grafias_e_ignora_los_blancos() {
    assert_eq!(init_prompt(&json!({ "initprompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "   " })), None);
    assert_eq!(init_prompt(&json!({})), None);
}

#[test]
fn los_nombres_de_skill_se_leen_del_array_que_manda_la_cli() {
    assert_eq!(
        skill_names(&json!({ "skills": ["a", "b"] })),
        Some(vec!["a".to_string(), "b".to_string()])
    );
    assert_eq!(skill_names(&json!({ "skills": [] })), None);
    assert_eq!(skill_names(&json!({})), None);
}

// ── Instalación del binario ─────────────────────────────────────

/// Instalar la CLI no puede pedir permisos de administrador.
#[test]
fn el_destino_es_una_carpeta_del_usuario() {
    let dir = target_dir().expect("debería resolverse en cualquier sistema con HOME");
    let home = dirs::home_dir().unwrap();
    assert!(dir.starts_with(&home), "el destino tiene que estar dentro del home del usuario");
}

/// Un symlink que quedó de una instalación anterior apunta a un binario viejo: tiene que
/// pedir reinstalación en vez de darse por instalado.
#[test]
fn un_symlink_que_apunta_a_otro_lado_no_cuenta_como_instalado() {
    let base = std::env::temp_dir().join(format!("cc-cli-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();

    let current = base.join("ccode-nuevo");
    let old = base.join("ccode-viejo");
    std::fs::write(&current, b"#!/bin/sh\n").unwrap();
    std::fs::write(&old, b"#!/bin/sh\n").unwrap();

    let link = base.join("link");
    assert!(!is_installed(&link, Some(&current)), "sin nada en el destino, no está instalado");

    symlink::symlink_file(&old, &link).unwrap();
    assert!(!is_installed(&link, Some(&current)));

    let _ = symlink::remove_symlink_auto(&link);
    symlink::symlink_file(&current, &link).unwrap();
    assert!(is_installed(&link, Some(&current)));

    let _ = std::fs::remove_dir_all(&base);
}

/// EL bug: dos skills instaladas con el mismo nombre y autores distintos. Quedarse con la
/// primera que devuelva SQLite le monta a la tab una skill que el usuario no pidió, sin
/// decir nada. Tiene que fallar y explicar cómo desambiguar.
#[test]
fn un_nombre_ambiguo_es_un_error_y_no_una_ruleta() {
    let dos = vec![
        skill("aaa", "testing", Some("anthropics"), Some("anthropics/skills")),
        skill("bbb", "testing", Some("midudev"), Some("autoskills")),
    ];

    let err = match_skill_ids(&dos, &["testing".to_string()]).unwrap_err();
    assert!(err.contains("aaa") && err.contains("bbb"), "tiene que listar las dos: {err}");
    assert!(err.contains("anthropics") && err.contains("midudev"), "y sus autores: {err}");

    // Con el id no hay ambigüedad posible.
    assert_eq!(match_skill_ids(&dos, &["bbb".to_string()]).unwrap(), vec!["bbb"]);
}

/// Con una sola instalada con ese nombre no hay nada que preguntar.
#[test]
fn un_nombre_sin_homonimas_se_resuelve_derecho() {
    let una = vec![skill("aaa", "testing", Some("anthropics"), None)];
    assert_eq!(match_skill_ids(&una, &["TESTING".to_string()]).unwrap(), vec!["aaa"]);
}

// ── El contrato entre `ccode` y el despachador ──────────────────

/// Los comandos que el binario `ccode` sabe nombrar, sacados de sus propias tablas.
fn cli_commands() -> Vec<String> {
    let src = include_str!("../bin/cli.rs");
    let mut out = Vec::new();
    // `shortcut()`: `"skills" => Some("skill.list"),`
    for cap in src.split("Some(\"").skip(1) {
        if let Some(cmd) = cap.split('"').next() {
            if cmd.contains('.') {
                out.push(cmd.to_string());
            }
        }
    }
    // `positionals()`: `"skill.show" | "skill.edit" => &["skill"],`
    for line in src.lines() {
        let line = line.trim();
        if !line.contains("=> &[") {
            continue;
        }
        for part in line.split("=>").next().unwrap_or("").split('|') {
            let name = part.trim().trim_matches(|c| c == '"' || c == ' ');
            if name.contains('.') {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Los comandos que el despachador atiende, sacados de su `match`.
fn dispatched_commands() -> Vec<String> {
    include_str!("commands/dispatch.rs")
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix('"')?;
            let (name, tail) = rest.split_once('"')?;
            tail.trim_start().starts_with("=>").then(|| name.to_string())
        })
        .filter(|c| c.contains('.'))
        .collect()
}

/// Que `ccode` nombre un comando que el backend ya no atiende no rompe nada en compilación
/// —son dos tablas de strings, en archivos distintos— y solo se nota cuando alguien lo
/// ejecuta y recibe "Comando desconocido". Este test es lo que ata las dos puntas.
#[test]
fn todo_lo_que_la_cli_sabe_nombrar_lo_atiende_el_despachador() {
    let dispatched = dispatched_commands();
    assert!(dispatched.len() > 15, "no se pudieron leer los comandos del despachador");

    let huerfanos: Vec<String> =
        cli_commands().into_iter().filter(|c| !dispatched.contains(c)).collect();
    assert!(huerfanos.is_empty(), "la CLI ofrece comandos que nadie atiende: {huerfanos:?}");
}

/// Y la contracara: un comando del backend que la ayuda de `ccode` no menciona es un
/// comando que nadie va a encontrar.
#[test]
fn la_ayuda_de_la_cli_menciona_los_comandos_de_skills() {
    let src = include_str!("../bin/cli.rs");
    for verbo in ["skill show", "skill new", "skill edit", "skill install", "skill search"] {
        assert!(src.contains(verbo), "la ayuda no menciona '{verbo}'");
    }
}

// ── `ccode mcp`: el puente MCP ──────────────────────────────────

use super::mcp::{browser_tool_names, orchestration_tool_names, serve, McpContext, OrchestrationPower};

/// Corre el servidor sobre una conversación entera y devuelve las respuestas y lo que se
/// le mandó a la app.
fn mcp_session(
    context: &McpContext,
    lines: &[serde_json::Value],
    reply: impl Fn(&str, &serde_json::Value) -> Result<serde_json::Value, String>,
) -> (Vec<serde_json::Value>, Vec<(String, serde_json::Value)>) {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut output = Vec::new();
    let mut sent = Vec::new();
    serve(context, input.as_bytes(), &mut output, |command, payload| {
        let answer = reply(command, &payload);
        sent.push((command.to_string(), payload));
        answer
    })
    .unwrap();
    let responses = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (responses, sent)
}

fn tool_names(response: &serde_json::Value) -> Vec<String> {
    response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

fn call(id: u64, name: &str, arguments: serde_json::Value) -> serde_json::Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } })
}

/// Una tab interactiva no tiene broker: sus permisos los contesta la persona en la
/// terminal. Ofrecerle `approve_tool_use` sería una tool que el modelo podría llamar para
/// "aprobarse" algo a sí mismo.
#[test]
fn una_tab_ve_el_navegador_y_una_tarea_ademas_el_broker() {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let (tab, _) = mcp_session(&McpContext::Cwd { cwd: "/p".into(), tab: None }, std::slice::from_ref(&list), |_, _| Ok(json!({})));
    let (task, _) = mcp_session(&McpContext::Task("t1".into()), &[list], |_, _| Ok(json!({})));

    let tab = tool_names(&tab[0]);
    let task = tool_names(&task[0]);
    assert!(!tab.contains(&"approve_tool_use".to_string()));
    assert!(tab.contains(&"browser_click".to_string()));
    assert_eq!(task[0], "approve_tool_use");
    assert_eq!(&task[1..], &tab[..]);

    // Lo que se permite de antemano en `--allowedTools` es exactamente lo que se ofrece:
    // un nombre de más no hace nada, uno de menos deja una tool pidiendo permiso por cada uso.
    let offered: Vec<String> = tab.iter().map(|n| format!("mcp__controlcode__{n}")).collect();
    let browser: Vec<String> = offered.iter().filter(|n| n.contains("__browser_")).cloned().collect();
    assert_eq!(browser_tool_names(), browser);
    let all_powers = [OrchestrationPower::Read, OrchestrationPower::Note, OrchestrationPower::Spawn];
    let orchestration = orchestration_tool_names(&all_powers);
    assert!(!orchestration.is_empty());
    assert!(orchestration.iter().all(|n| offered.contains(n)), "{orchestration:?}");
    // Preguntarle algo al usuario va para los dos lados y no es ni navegador ni orquestación.
    assert!(tab.contains(&super::mcp::ASK_TOOL.to_string()));
    assert_eq!(browser.len() + orchestration.len() + 1, offered.len());
}

/// Lanzar o parar agentes gasta plata: eso nunca va permitido de antemano a alguien que
/// solo debería leer. Mirar el run y dejar un hecho, sí.
#[test]
fn las_tools_que_lanzan_agentes_no_se_permiten_con_las_de_lectura() {
    let light = orchestration_tool_names(&[OrchestrationPower::Read, OrchestrationPower::Note]);
    for spawning in ["run_plan", "task_add", "task_cancel", "task_reroute"] {
        assert!(!light.iter().any(|n| n.ends_with(spawning)), "{spawning} no puede ir con las de lectura");
    }
    for reading in ["agent_roster", "task_status", "task_result", "run_await", "facts_read", "fact_add"] {
        assert!(light.iter().any(|n| n.ends_with(reading)), "falta {reading}");
    }
}

/// Una tool de orquestación viaja con quién la pide y sus argumentos tal cual: la app
/// decide sobre qué run actúa, no el agente.
#[test]
fn una_tool_de_orquestacion_viaja_con_quien_la_pide() {
    let (responses, sent) = mcp_session(
        &McpContext::Task("t-3".into()),
        &[call(5, "run_await", json!({ "timeout_s": 60, "run_id": "otro" }))],
        |_, _| Ok(json!({ "text": "Terminaron: api (done)" })),
    );
    assert_eq!(sent[0].0, "run.await");
    assert_eq!(sent[0].1, json!({ "taskId": "t-3", "args": { "timeout_s": 60, "run_id": "otro" } }));
    assert_eq!(responses[0]["result"]["content"][0]["text"], "Terminaron: api (done)");
}

#[test]
fn una_tool_del_navegador_viaja_como_browser_run_con_su_carpeta() {
    let (responses, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/home/u/proyecto".into(), tab: None },
        &[
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            call(7, "browser_type", json!({ "target": "e3", "text": "ana@x.com", "submit": true })),
        ],
        |_, _| Ok(json!({ "text": "{\"typed\":\"input#email\"}" })),
    );

    // La notificación no lleva respuesta: contestarla rompe a los clientes estrictos.
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], 7);
    assert_eq!(responses[0]["result"]["content"][0]["text"], "{\"typed\":\"input#email\"}");
    assert!(responses[0]["result"].get("isError").is_none());

    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "browser.run");
    assert_eq!(
        sent[0].1,
        json!({ "cwd": "/home/u/proyecto", "request": { "op": "type", "target": "e3", "text": "ana@x.com", "submit": true } })
    );
}

/// El `--mcp-config` de cada agente lleva la ruta de `ccode` sacada de al lado de la app.
/// Si no se encuentra, la tab arranca SIN navegador y sin orquestación, en silencio, y el
/// botón de instalar la CLI falla — así que tiene que encontrarse en los cinco
/// empaquetados, no solo en el que usa quien lo programó.
#[test]
fn se_encuentra_ccode_en_todos_los_empaquetados() {
    let cli = if cfg!(windows) { "ccode.exe" } else { "ccode" };
    let base = std::env::temp_dir().join(format!("cc-pack-{}", uuid::Uuid::new_v4()));

    // Dónde queda el binario en cada uno, y desde qué carpeta corre el ejecutable.
    let layouts: [(&str, &str, &str); 5] = [
        ("deb/rpm", "usr/bin", "usr/bin"),
        ("cargo build", "target/debug", "target/debug"),
        ("windows", "app/binaries", "app"),
        ("macos", "App.app/Contents/Resources/binaries", "App.app/Contents/MacOS"),
        ("appimage", "usr/lib/controlcode/binaries", "usr/bin"),
    ];

    for (name, where_bin, where_exe) in layouts {
        let root = base.join(name.replace('/', "-"));
        let bin = root.join(where_bin);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join(where_exe)).unwrap();
        std::fs::write(bin.join(cli), b"#!/bin/sh\n").unwrap();

        let found = super::install::source_binary_in(&root.join(where_exe));
        let found = found.unwrap_or_else(|| panic!("no se encontró ccode empaquetado como {name}"));
        assert_eq!(found.canonicalize().unwrap(), bin.join(cli).canonicalize().unwrap(), "{name}");
    }

    // Y sin binario no se inventa una ruta: es lo que hace que la app lo diga en vez de
    // escribir un `--mcp-config` que apunta a la nada.
    let vacio = base.join("vacio");
    std::fs::create_dir_all(&vacio).unwrap();
    assert!(super::install::source_binary_in(&vacio).is_none());

    std::fs::remove_dir_all(&base).ok();
}

/// Cada tab y cada tarea escribe su `--mcp-config`, y al cerrarse no lo limpian. Sin este
/// barrido `~/.controlcode/mcp` crece para siempre con archivos que no apunta nadie.
#[test]
fn el_barrido_borra_los_configs_de_tabs_y_tareas_que_ya_no_estan() {
    let conn = crate::database::test_db();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES ('w1', 'main', 'ws', 1, 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
            VALUES ('viva', 'w1', 'claude-code', 'Claude Code', 'claude', '/tmp/uno', 0, 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at) VALUES ('r1', 'ws', 'x', '/tmp', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, cwd, created_at)
            VALUES ('tarea-viva', 'r1', 't', 'p', 'claude-code', '/tmp', 0);",
    )
    .unwrap();

    let dir = std::env::temp_dir().join(format!("cc-mcp-sweep-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["tab-viva.json", "tab-cerrada.json", "tarea-viva.json", "tarea-borrada.json"] {
        std::fs::write(dir.join(name), "{}").unwrap();
    }

    assert_eq!(super::mcp::sweep_configs_in(&dir, &conn), 2);
    let mut quedaron: Vec<String> =
        std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    quedaron.sort();
    assert_eq!(quedaron, vec!["tab-viva.json", "tarea-viva.json"]);

    // Y es idempotente: correrlo de nuevo no borra lo que sí está vivo.
    assert_eq!(super::mcp::sweep_configs_in(&dir, &conn), 0);
    std::fs::remove_dir_all(&dir).ok();
}

/// La tab que lanzó el servidor viaja en cada pedido: es con lo que la app le da a ESE
/// agente su propio navegador, en vez de que todos escriban en la página del usuario.
#[test]
fn el_pedido_dice_de_que_tab_viene() {
    let (_, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: Some("tab-7".into()) },
        &[call(1, "browser_snapshot", json!({}))],
        |_, _| Ok(json!({ "text": "page: …" })),
    );
    assert_eq!(sent[0].1, json!({ "cwd": "/p", "tabId": "tab-7", "request": { "op": "snapshot" } }));
}

/// Desde una tarea, el navegador se pide por la tarea: la app sabe de qué proyecto es,
/// aunque la tarea corra en un worktree con otra carpeta.
#[test]
fn desde_una_tarea_el_navegador_se_pide_por_la_tarea() {
    let (_, sent) = mcp_session(
        &McpContext::Task("t-9".into()),
        &[call(1, "browser_snapshot", json!({}))],
        |_, _| Ok(json!({ "text": "page: …" })),
    );
    assert_eq!(sent[0].1, json!({ "taskId": "t-9", "request": { "op": "snapshot" } }));
}

/// "No hay elemento e12" es algo que el agente tiene que leer para corregirse, no una
/// falla del protocolo que lo corte.
#[test]
fn un_error_del_navegador_llega_al_agente_como_resultado_con_error() {
    let (responses, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None },
        &[call(2, "browser_click", json!({ "target": "e12" }))],
        |_, _| Err("No hay ningún elemento e12: tomá un snapshot nuevo".into()),
    );
    let result = &responses[0]["result"];
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("e12"));
}

#[test]
fn desde_una_tab_no_se_puede_llamar_al_broker() {
    let (responses, sent) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None },
        &[call(3, "approve_tool_use", json!({ "tool_name": "Bash", "input": {} }))],
        |_, _| Ok(json!({ "allow": true })),
    );
    assert!(sent.is_empty(), "no puede llegar a la app: {sent:?}");
    assert_eq!(responses[0]["result"]["isError"], true);
}

#[test]
fn el_broker_deniega_si_la_app_no_contesta() {
    let (responses, _) = mcp_session(
        &McpContext::Task("t1".into()),
        &[call(4, "approve_tool_use", json!({ "tool_name": "Edit", "input": { "file_path": "a" } }))],
        |_, _| Err("conexión rechazada".into()),
    );
    let text = responses[0]["result"]["content"][0]["text"].as_str().unwrap();
    let verdict: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(verdict["behavior"], "deny");
}

#[test]
fn el_initialize_devuelve_la_version_pedida_y_explica_el_navegador() {
    let (responses, _) = mcp_session(
        &McpContext::Cwd { cwd: "/p".into(), tab: None },
        &[json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } })],
        |_, _| Ok(json!({})),
    );
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-11-25");
    let instructions = responses[0]["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("never instructions"));
    assert!(instructions.contains("run_plan"));
}

/// Lo que el puente MCP le manda a la app también son comandos del despachador; y
/// `browser.run` además tiene que atenderlo el frontend, que es donde vive la página.
#[test]
fn lo_que_manda_el_puente_mcp_lo_atienden_el_despachador_y_el_frontend() {
    let dispatched = dispatched_commands();
    let mcp = include_str!("mcp.rs");
    for command in ["run.approve", "browser.run"] {
        assert!(mcp.contains(&format!("send(\"{command}\"")), "el puente ya no manda {command}");
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
    }
    // Y cada tool de orquestación nombra un comando que el despachador atiende.
    let orchestration: Vec<&str> = mcp
        .split("command: \"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .collect();
    assert!(orchestration.len() >= 9, "{orchestration:?}");
    for command in orchestration {
        assert!(dispatched.contains(&command.to_string()), "nadie atiende {command}");
        assert!(
            include_str!("../runs/orchestration.rs").contains(&format!("\"{command}\" =>")),
            "la orquestación no atiende {command}"
        );
    }
    let bridge = include_str!("../../../src/features/orchestrator/cliBridge.ts");
    assert!(bridge.contains("case \"browser.run\""), "el frontend no atiende browser.run");
}
