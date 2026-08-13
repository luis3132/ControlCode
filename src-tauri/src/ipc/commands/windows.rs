//! Comandos de ventanas.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;

pub(super) fn window_list(app: &AppHandle) -> Result<Value, String> {
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

pub(super) fn window_create(app: &AppHandle) -> Result<Value, String> {
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

