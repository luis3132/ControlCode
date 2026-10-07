//! Lo que un agente manda por su cuenta desde `ccode mcp`: pedir permiso y orquestar.
//!
//! No llegan desde una persona escribiendo en una terminal, sino desde el MCP de una tarea
//! o de una tab. Por eso son los que **bloquean de verdad**: `run.approve` hasta una hora
//! (del otro lado hay alguien mirando un diff) y `run.await` lo que el agente pida.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::ipc::protocol::arg_str;

/// `run.approve` — ¿puede esta tarea (o esta tab en modo HTML) usar esta herramienta?
pub(super) fn run_approve(app: &AppHandle, args: &Value) -> Result<Value, String> {
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

    let timeout = Duration::from_secs(timeout);
    let verdict = match args.get("taskId").and_then(Value::as_str) {
        Some(task_id) => crate::runs::resolve_permission(app, &db, task_id, &tool_name, input, timeout),
        None => {
            let tab_id = arg_str(args, "tabId")?;
            let cwd = arg_str(args, "cwd")?;
            let tool_use_id = args.get("toolUseId").and_then(Value::as_str).map(str::to_string);
            crate::runs::resolve_tab_permission(app, &db, &tab_id, &cwd, &tool_name, input, tool_use_id, timeout)
        }
    };

    Ok(json!({ "allow": verdict.allow, "reason": verdict.reason }))
}

/// `run.plan`, `run.status`, `run.await`… — ver `runs::orchestration`.
pub(super) fn run_orchestrate(app: &AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    crate::runs::orchestration::handle(app, command, args)
}
