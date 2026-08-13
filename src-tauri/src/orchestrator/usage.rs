//! Contabilidad de lo que el modo orquestador consume, y el estado que ve la UI.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

use super::{digest, watch};

/// Clave en la tabla `settings`. Compartida con el frontend (Ajustes → Orquestador).
pub const WATCH_LIMIT_KEY: &str = "orchestrator_watch_limit";
pub const DEFAULT_WATCH_LIMIT: usize = 3;

/// Evento que refresca el indicador de la UI. Se emite a todas las ventanas.
const STATS_EVENT: &str = "cc-orchestrator-stats";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Comandos de la CLI atendidos desde que arrancó la app.
    pub requests: u64,
    /// Bytes de JSON devueltos a la CLI.
    pub response_bytes: u64,
    /// Tokens estimados de esos bytes (ver `digest::estimate_tokens`).
    pub estimated_tokens: u64,
    pub last_command: Option<String>,
    pub last_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(flatten)]
    pub usage: Usage,
    /// Tabs bajo observación ahora mismo.
    pub watched: usize,
    pub watch_limit: usize,
}

lazy_static::lazy_static! {
    static ref USAGE: Mutex<Usage> = Mutex::new(Usage::default());
}

fn usage() -> MutexGuard<'static, Usage> {
    USAGE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Límite de tabs observadas en simultáneo. Si el valor guardado no se puede leer o no es
/// un número, se cae al default en vez de fallar: quedarse sin límite sería peor que
/// ignorar una configuración rota.
pub fn watch_limit(db: &crate::database::DbConnection) -> usize {
    crate::database::get_setting(db, WATCH_LIMIT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_WATCH_LIMIT)
}

/// Contabiliza una respuesta ya serializada y avisa a la UI.
pub fn record_response(app: &AppHandle, command: &str, body: &str) {
    {
        let mut u = usage();
        u.requests += 1;
        u.response_bytes += body.len() as u64;
        u.estimated_tokens += digest::estimate_tokens(body);
        u.last_command = Some(command.to_string());
        u.last_at = Some(watch::now());
    }
    emit_stats(app);
}

pub fn emit_stats(app: &AppHandle) {
    let _ = app.emit(STATS_EVENT, stats_with_limit(0));
}

fn stats_with_limit(limit: usize) -> Stats {
    Stats {
        usage: usage().clone(),
        watched: watch::count(),
        // 0 = "no lo sé desde acá": el límite vive en SQLite y el emisor no siempre tiene
        // la conexión a mano. El frontend ya lo tiene leído de Ajustes.
        watch_limit: limit,
    }
}

/// Estado del modo orquestador. Lo pide la UI al montar; después se mantiene con el evento.
#[tauri::command]
pub fn orchestrator_stats(db: tauri::State<crate::database::DbConnection>) -> Result<Stats, String> {
    Ok(stats_with_limit(watch_limit(&db)))
}

/// Pone el contador en cero. Sirve para medir una tarea concreta ("¿cuánto costó esto?")
/// sin reiniciar la app.
#[tauri::command]
pub fn orchestrator_reset_usage(app: AppHandle) -> Result<(), String> {
    *usage() = Usage::default();
    emit_stats(&app);
    Ok(())
}
