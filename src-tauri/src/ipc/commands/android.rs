//! `android.run`: un agente usando el dispositivo Android, desde las tools `android_*`.
//!
//! El trabajo lo hace `crate::android::agent`, en el backend. Lo que se suma acá es la
//! ventana: que aparezca la vista "Dispositivo" del proyecto si no estaba (sin quitarle a la
//! persona lo que está mirando) y que cada toque se dibuje con el color del agente.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::browser::{project_of_task, window_with_folder, window_with_tab};

pub(super) fn android_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let request = args
        .get("request")
        .filter(|r| r.get("op").and_then(Value::as_str).is_some())
        .cloned()
        .ok_or_else(|| "Falta qué hacer en el dispositivo ('request.op')".to_string())?;
    let cwd = match args.get("cwd").and_then(Value::as_str) {
        Some(cwd) => Some(cwd.to_string()),
        None => args.get("taskId").and_then(Value::as_str).and_then(|id| project_of_task(app, id).ok()),
    };
    let owner = args.get("tabId").and_then(Value::as_str).map(|id| json!({ "kind": "tab", "id": id })).or_else(
        || args.get("taskId").and_then(Value::as_str).map(|id| json!({ "kind": "task", "id": id })),
    );
    let actor = owner.as_ref().and_then(|o| o.get("id")).and_then(Value::as_str).unwrap_or("").to_string();

    let outcome = crate::android::agent::run(&request, &actor, cwd.as_deref())?;

    if let Some(serial) = &outcome.serial {
        let window = match args.get("tabId").and_then(Value::as_str) {
            Some(tab) => window_with_tab(app, tab).ok().flatten(),
            None => None,
        }
        .or_else(|| cwd.as_deref().and_then(|c| window_with_folder(app, c).ok().flatten()));
        let open = json!({ "cwd": cwd, "serial": serial, "owner": owner });
        let _ = match &window {
            Some(label) => app.emit_to(label.as_str(), "android-agent", &open),
            None => app.emit("android-agent", &open),
        };
        for touch in &outcome.touches {
            let _ = app.emit("android-touch", json!({ "touch": touch, "owner": owner }));
        }
    }

    let mut data = json!({ "text": outcome.text });
    if let Some((image, mime)) = outcome.image {
        data["image"] = json!(image);
        data["mime"] = json!(mime);
    }
    Ok(data)
}
