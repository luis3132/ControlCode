//! Comandos del modo push: qué tabs se observan y cómo se espera un evento.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;
use super::tabs::pty_id_for_tab;
use crate::ipc::protocol::{arg_str, arg_str_opt, arg_u64_opt};

fn watch_limit(app: &AppHandle) -> Result<usize, String> {
    let db = db(app)?;
    Ok(crate::orchestrator::watch_limit(&db))
}

pub(super) fn watch_add(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let pty_id = pty_id_for_tab(app, &tab_id, arg_str_opt(args, "window").as_deref())?;
    let idle = arg_u64_opt(args, "idle").unwrap_or(crate::orchestrator::watch::DEFAULT_IDLE_SECS);
    let limit = watch_limit(app)?;

    crate::orchestrator::watch::add(pty_id, &tab_id, idle, limit)?;
    crate::orchestrator::emit_stats(app);

    Ok(json!({ "tabId": tab_id, "watching": true, "idleSecs": idle, "limit": limit }))
}

pub(super) fn watch_remove(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let tab_id = arg_str(args, "tab")?;
    let removed = crate::orchestrator::watch::remove_tab(&tab_id);
    if !removed {
        return Err(format!("La tab {tab_id} no estaba siendo observada"));
    }
    crate::orchestrator::forget_cursor(&tab_id);
    crate::orchestrator::emit_stats(app);
    Ok(json!({ "tabId": tab_id, "watching": false }))
}

pub(super) fn watch_list(app: &AppHandle) -> Result<Value, String> {
    Ok(json!({
        "watched": crate::orchestrator::watch::list(),
        "limit": watch_limit(app)?,
    }))
}

/// Bloquea hasta que alguna tab observada tenga algo que contar. Es lo que reemplaza al
/// polling: la llamada duerme en el backend (que no gasta contexto) en vez de que el
/// modelo relea tabs cada N segundos (que sí gasta).
pub(super) fn watch_wait(args: &Value) -> Result<Value, String> {
    /// Tope duro para no dejar una conexión colgada indefinidamente si el llamador pide
    /// un timeout absurdo.
    const MAX_TIMEOUT_SECS: u64 = 3600;

    if crate::orchestrator::watch::count() == 0 {
        return Err(
            "No hay ninguna tab observada. Agregá una con 'ccode watch add --tab <id>'".to_string(),
        );
    }

    let timeout = arg_u64_opt(args, "timeout").unwrap_or(300).min(MAX_TIMEOUT_SECS);
    let max = arg_u64_opt(args, "max").unwrap_or(20) as usize;

    let events = crate::orchestrator::watch::wait(std::time::Duration::from_secs(timeout), max);
    Ok(json!({
        "events": events,
        // Sin esto, "no pasó nada" y "se venció el timeout" se ven igual desde la CLI.
        "timedOut": events.is_empty(),
    }))
}
