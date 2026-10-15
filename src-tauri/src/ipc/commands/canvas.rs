//! `canvas.run`: un agente manejando el canvas de su workspace (páginas, nodos, vista).
//!
//! Igual que el navegador: llega desde `ccode mcp` y lo resuelve el frontend, que es donde
//! vive el canvas. El backend solo decide a qué ventana preguntarle y le dice quién pide,
//! para que la ventana pinte lo que toca ese agente con su color.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use super::browser::{project_of_task, window_with_folder, window_with_tab};
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::protocol::arg_str;

/// Casi todo es instantáneo; crear un agente espera a que sus skills estén en disco.
const CANVAS_TIMEOUT_SECS: u64 = 60;

pub(super) fn canvas_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let request = args
        .get("request")
        .filter(|r| r.get("op").and_then(Value::as_str).is_some())
        .cloned()
        .ok_or_else(|| "Falta qué hacer en el canvas ('request.op')".to_string())?;

    let cwd = match args.get("cwd").and_then(Value::as_str) {
        Some(cwd) => cwd.to_string(),
        None => project_of_task(app, &arg_str(args, "taskId")?)?,
    };
    let owner = args.get("tabId").and_then(Value::as_str).map(|id| json!({ "kind": "tab", "id": id })).or_else(
        || args.get("taskId").and_then(Value::as_str).map(|id| json!({ "kind": "task", "id": id })),
    );
    let window = match args.get("tabId").and_then(Value::as_str) {
        Some(tab) => window_with_tab(app, tab)?.map_or_else(|| window_with_folder(app, &cwd), |w| Ok(Some(w)))?,
        None => window_with_folder(app, &cwd)?,
    };

    let raw = ask_frontend_within(
        app,
        "canvas.run",
        &json!({ "cwd": cwd, "request": request, "owner": owner }),
        window.as_deref(),
        Duration::from_secs(CANVAS_TIMEOUT_SECS),
    )?;
    unwrap_frontend_result(raw)
}
