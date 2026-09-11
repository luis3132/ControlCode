//! El único comando que un agente headless manda por su cuenta: pedir permiso.
//!
//! Llega desde el `ccode mcp --task <id>` que la propia tarea lanzó, no desde una persona
//! escribiendo en una terminal. Por eso es el único de la CLI que **bloquea de verdad**
//! hasta una hora: del otro lado hay alguien que tiene que mirar un diff.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::ipc::protocol::arg_str;

/// `run.approve` — ¿puede esta tarea usar esta herramienta?
pub(super) fn run_approve(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task_id = arg_str(args, "taskId")?;
    let tool_name = arg_str(args, "toolName")?;
    let input = args.get("input").cloned().unwrap_or(json!({}));
    let timeout = args
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(crate::ipc::mcp::APPROVAL_TIMEOUT_SECS);

    let db = app
        .try_state::<crate::database::DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone();

    let verdict =
        crate::runs::resolve_permission(app, &db, &task_id, &tool_name, input, Duration::from_secs(timeout));

    Ok(json!({ "allow": verdict.allow, "reason": verdict.reason }))
}
