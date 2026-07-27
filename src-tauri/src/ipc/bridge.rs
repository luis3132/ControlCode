//! Puente CLI → frontend, para los comandos que el backend no puede resolver solo.
//!
//! Crear o cerrar una tab es estado del frontend (el store de Zustand es la fuente de
//! verdad mientras la app corre; SQLite es su reflejo, escrito con debounce). Si la CLI
//! insertara filas directo en SQLite, la ventana abierta seguiría mostrando lo de antes y
//! el próximo autosave pisaría el cambio.
//!
//! Entonces: se emite un evento a una ventana concreta, se espera su respuesta con un id
//! de correlación, y se devuelve eso a la CLI. Si nadie responde a tiempo se reporta
//! timeout en vez de quedar colgado.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// Cuánto se espera al frontend antes de darlo por no disponible. Generoso a propósito:
/// crear una tab implica montar una terminal y esperar los symlinks de sus skills.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

lazy_static::lazy_static! {
    /// Requests en vuelo, por id de correlación. Se saca la entrada al responder o al
    /// vencer el timeout, así el mapa no crece.
    static ref PENDING: Mutex<HashMap<String, Sender<Value>>> = Mutex::new(HashMap::new());
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: String,
    /// Solo la ventana con este label debe atender la request (el evento llega a todas).
    target_label: String,
    command: String,
    args: Value,
}

/// Ventana a la que dirigir la request: la que el usuario pidió por `--window`, o
/// cualquiera abierta si no especificó.
fn resolve_target(app: &AppHandle, requested: Option<&str>) -> Result<String, String> {
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    if labels.is_empty() {
        return Err("La app no tiene ninguna ventana abierta".to_string());
    }
    match requested {
        Some(label) => labels
            .into_iter()
            .find(|l| l == label)
            .ok_or_else(|| format!("No hay ninguna ventana con el label '{label}'")),
        // `webview_windows` no garantiza orden, así que se ordena para que dos llamadas
        // seguidas sin `--window` no caigan en ventanas distintas.
        None => {
            let mut sorted = labels;
            sorted.sort();
            Ok(sorted.remove(0))
        }
    }
}

/// Manda una request al frontend y espera su respuesta.
pub fn ask_frontend(
    app: &AppHandle,
    command: &str,
    args: &Value,
    window: Option<&str>,
) -> Result<Value, String> {
    let target_label = resolve_target(app, window)?;
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = channel();

    PENDING.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), tx);

    let payload = BridgeRequest {
        request_id: request_id.clone(),
        target_label,
        command: command.to_string(),
        args: args.clone(),
    };
    if let Err(e) = app.emit("cc-cli-request", payload) {
        PENDING.lock().ok().and_then(|mut p| p.remove(&request_id));
        return Err(format!("No se pudo notificar a la ventana: {e}"));
    }

    let result = rx.recv_timeout(RESPONSE_TIMEOUT).map_err(|_| {
        "La ventana no respondió a tiempo (¿está la app respondiendo?)".to_string()
    });

    PENDING.lock().ok().and_then(|mut p| p.remove(&request_id));
    result
}

/// El frontend devuelve acá el resultado de una request del puente.
///
/// `error` viene separado de `data` para que el frontend pueda reportar un fallo de
/// negocio (por ejemplo, "no existe esa tab") sin que el puente tenga que adivinarlo
/// mirando la forma de `data`.
#[tauri::command]
pub fn cli_respond(
    request_id: String,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = PENDING.lock().map_err(|e| e.to_string())?.get(&request_id).cloned();
    let Some(sender) = sender else {
        // Llegó tarde (ya venció el timeout) o duplicada: se ignora en silencio, no es un
        // error del frontend.
        return Ok(());
    };

    let payload = match error {
        Some(msg) => serde_json::json!({ "__error": msg }),
        None => data.unwrap_or(Value::Null),
    };
    let _ = sender.send(payload);
    Ok(())
}

/// Desarma la convención de `__error` que usa `cli_respond` para transportar fallos.
pub fn unwrap_frontend_result(value: Value) -> Result<Value, String> {
    if let Some(msg) = value.get("__error").and_then(|v| v.as_str()) {
        return Err(msg.to_string());
    }
    Ok(value)
}
