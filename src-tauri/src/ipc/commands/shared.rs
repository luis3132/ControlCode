//! Piezas que comparten los handlers: el acceso a la base y el puente al frontend.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::database::DbConnection;
use crate::ipc::bridge::{ask_frontend, unwrap_frontend_result};
use crate::ipc::protocol::arg_str_opt;

pub(super) fn db(app: &AppHandle) -> Result<tauri::State<'_, DbConnection>, String> {
    app.try_state::<DbConnection>().ok_or_else(|| "La base de datos no está lista".to_string())
}

pub(super) fn bridge_call(app: &AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    let window = arg_str_opt(args, "window");
    let raw = ask_frontend(app, command, args, window.as_deref())?;
    unwrap_frontend_result(raw)
}
