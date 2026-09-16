//! `user.ask`: un agente preguntándole algo a la persona que lo está mirando.
//!
//! Hay cosas que un agente no puede averiguar leyendo: con qué usuario probar, si el diseño
//! nuevo va arriba o al costado, cuál de dos caminos prefiere quien pidió el trabajo.
//! Hasta ahora la única salida era adivinar o dejarlo escrito en el resultado y frenar.
//!
//! Es lo contrario de `approve_tool_use`: ahí el agente pide permiso para algo que ya
//! decidió; acá pide que decidan por él. Por eso no pasa por el broker ni por reglas —una
//! pregunta no se puede "recordar"— y lo resuelve el frontend, que es donde está la persona.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};

/// Cuánto espera una pregunta. Largo como el de los permisos y por lo mismo: del otro lado
/// hay alguien que puede estar en otra cosa, y cortar a los treinta segundos convertiría
/// "todavía no la vi" en "no contestó".
const ASK_TIMEOUT_SECS: u64 = 1800;

/// Cuántas opciones se pueden ofrecer. Más que esto no es una pregunta: es un menú, y
/// entra mejor como texto libre.
const MAX_OPTIONS: usize = 6;

pub(super) fn user_ask(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let question = args
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| "falta la pregunta ('question')".to_string())?;

    let options: Vec<String> = args
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|o| !o.is_empty())
                .take(MAX_OPTIONS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let timeout = args
        .get("timeout_s")
        .and_then(Value::as_u64)
        .unwrap_or(ASK_TIMEOUT_SECS)
        .clamp(30, ASK_TIMEOUT_SECS);

    let raw = ask_frontend_within(
        app,
        "user.ask",
        &json!({
            "question": question,
            "options": options,
            "placeholder": args.get("placeholder").and_then(Value::as_str),
            // Quién pregunta, para que la tarjeta lo diga: con varios agentes corriendo,
            // "¿cuál de todos me está preguntando esto?" no puede quedar sin respuesta.
            "taskId": args.get("taskId").and_then(Value::as_str),
            "tabId": args.get("tabId").and_then(Value::as_str),
            "cwd": args.get("cwd").and_then(Value::as_str),
        }),
        None,
        // Margen sobre lo que espera el frontend: si vence allá, vence allá y contesta.
        Duration::from_secs(timeout + 30),
    )?;
    unwrap_frontend_result(raw)
}
