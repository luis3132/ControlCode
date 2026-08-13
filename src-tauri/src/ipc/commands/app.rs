//! Estado general de la app.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};


pub(super) fn app_status(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "version": app.package_info().version.to_string(),
        "protocol": crate::ipc::protocol::PROTOCOL_VERSION,
        "windows": app.webview_windows().len(),
    }))
}
