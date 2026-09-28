//! Las preguntas de los agentes (`ask_user`) mientras esperan respuesta.
//!
//! La pregunta la sigue atendiendo la ventana (ver `ipc::commands::ask`); acá solo queda
//! anotada para que el teléfono la vea y la pueda contestar. Conteste quien conteste
//! primero, esa es la respuesta: la otra llega tarde y se descarta.

use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAsk {
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
    pub placeholder: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<String>,
    pub cwd: Option<String>,
}

lazy_static::lazy_static! {
    /// Cada pregunta con el id de la request del puente que la está esperando.
    static ref ASKS: Mutex<Vec<(PendingAsk, String)>> = Mutex::new(Vec::new());
}

fn asks() -> std::sync::MutexGuard<'static, Vec<(PendingAsk, String)>> {
    ASKS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn list() -> Vec<PendingAsk> {
    asks().iter().map(|(a, _)| a.clone()).collect()
}

pub fn register(app: &AppHandle, request_id: &str, ask: PendingAsk) {
    asks().push((ask, request_id.to_string()));
    super::client::broadcast("asks", json!({ "list": list() }));
    super::push::notify_offline(app, "Un agente te hace una pregunta", "Abrí Control Code para contestarla.");
}

pub fn unregister(_app: &AppHandle, id: &str) {
    let removed = {
        let mut all = asks();
        let before = all.len();
        all.retain(|(a, _)| a.id != id);
        all.len() != before
    };
    if removed {
        super::client::broadcast("asks", json!({ "list": list() }));
    }
}

/// Contesta desde el teléfono. `false` si ya no espera (la contestaron en la ventana, o
/// venció).
pub fn answer(app: &AppHandle, id: &str, text: &str) -> bool {
    let request_id = asks().iter().find(|(a, _)| a.id == id).map(|(_, r)| r.clone());
    let Some(request_id) = request_id else { return false };
    let answered = crate::ipc::bridge::respond(&request_id, json!({ "text": text }));
    if answered {
        // Que la tarjeta de la ventana se cierre: ya no hay nada que contestar ahí.
        let _ = app.emit("cc-ask-resolved", json!({ "askId": id }));
    }
    answered
}
