//! Comandos de workspaces.

use serde_json::{json, Value};
use tauri::AppHandle;

use rusqlite::OptionalExtension;

use super::shared::db;
use super::tabs::tab_list;
use super::windows::window_list;
use crate::ipc::protocol::arg_str;

pub(super) fn workspace_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let rows = crate::database::db_list_workspaces(db)?;
    Ok(json!({ "workspaces": rows }))
}

pub(super) fn workspace_open(app: &AppHandle, args: &Value) -> Result<Value, String> {
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
pub(super) fn workspace_status(app: &AppHandle) -> Result<Value, String> {
    let windows = window_list(app)?;
    let tabs = tab_list(app)?;
    Ok(json!({
        "windows": windows.get("windows").cloned().unwrap_or(Value::Null),
        "tabs": tabs.get("tabs").cloned().unwrap_or(Value::Null),
    }))
}

