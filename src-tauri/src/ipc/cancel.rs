//! Las llamadas del MCP que el agente canceló (`notifications/cancelled`).
//!
//! El puente (`ccode mcp`) deja de esperar solo; esto es para que la app, además, corte lo
//! que puede cortar: `run_await` deja de esperar en vez de quedarse hasta una hora con una
//! conexión que ya nadie lee. Cada llamada llega con un `callId` único (ver `mcp::serve`).

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

/// Las canceladas más recientes. Con tope: un id solo sirve mientras su llamada corre.
const KEEP: usize = 256;

static CANCELLED: LazyLock<Mutex<VecDeque<String>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

pub fn cancel(call_id: &str) {
    let mut ids = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    if ids.len() >= KEEP {
        ids.pop_front();
    }
    ids.push_back(call_id.to_string());
}

/// Sin `callId` (un pedido de la CLI, no del MCP) nunca está cancelado.
pub fn is_cancelled(call_id: Option<&str>) -> bool {
    let Some(id) = call_id else { return false };
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|c| c == id)
}
