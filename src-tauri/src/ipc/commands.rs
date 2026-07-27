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
        "tab.create" => bridge_call(app, "tab.create", args),
        "tab.close" => bridge_call(app, "tab.close", args),
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
fn pty_id_for_tab(app: &AppHandle, tab_id: &str) -> Result<u32, String> {
    let raw = ask_frontend(app, "tab.ptyId", &json!({ "tabId": tab_id }), None)?;
    let value = unwrap_frontend_result(raw)?;
    value
        .get("ptyId")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| format!("La tab {tab_id} no tiene un proceso corriendo"))
}

/// Salida de una tab. `lines` acota cuántas líneas del final se devuelven — la Fase 9 va
/// a agregar el resumen comprimido; por ahora el recorte por líneas ya evita el caso
/// patológico de devolver un scrollback de miles de líneas a un modelo.
fn tab_output(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id)?;

    let scrollback = crate::terminal::scrollback_of(pty_id)
        .ok_or_else(|| format!("La tab {tab_id} no tiene salida disponible"))?;

    let limit = arg_u64_opt(args, "lines").unwrap_or(200) as usize;
    let all: Vec<&str> = scrollback.lines().collect();
    let start = all.len().saturating_sub(limit);
    let truncated = start > 0;

    Ok(json!({
        "tabId": tab_id,
        "lines": all[start..],
        "truncated": truncated,
        "totalLines": all.len(),
    }))
}

fn tab_send(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let text = arg_str(args, "text")?;
    let pty_id = pty_id_for_tab(app, &tab_id)?;

    // Por defecto se manda Enter al final: "send" en una TUI interactiva casi siempre
    // significa "escribí esto y confirmá". `--no-enter` sirve para mandar teclas sueltas.
    let data = if args.get("noEnter").and_then(|v| v.as_bool()).unwrap_or(false) {
        text
    } else {
        format!("{text}\r")
    };

    crate::terminal::write_to_pty(pty_id, &data)?;
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

fn skill_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let installed = crate::skills::list_skills(db.clone())?;
    let available = crate::marketplace::list_marketplace_skills(None, None, db)?;
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
            format!("No se encontró '{skill}' en los repositorios habilitados (probá refrescarlos)")
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
