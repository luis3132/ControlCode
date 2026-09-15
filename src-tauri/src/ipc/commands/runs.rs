//! Lo que un agente manda por su cuenta desde `ccode mcp`: pedir permiso y orquestar.
//!
//! No llegan desde una persona escribiendo en una terminal, sino desde el MCP de una tarea
//! o de una tab. Por eso son los que **bloquean de verdad**: `run.approve` hasta una hora
//! (del otro lado hay alguien mirando un diff) y `run.await` lo que el agente pida.

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

/// `run.plan`, `run.status`, `run.await`… — ver `runs::orchestration`.
pub(super) fn run_orchestrate(app: &AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    crate::runs::orchestration::handle(app, command, args)
}
