//! `browser.run`: un agente usando el navegador de las tabs de su proyecto.
//!
//! Llega desde `ccode mcp` —el de una tab de Claude Code (`--cwd`) o el de una tarea de la
//! flota (`--task`)— y lo resuelve el frontend, que es donde viven la tab del navegador y
//! la página. El backend solo decide a qué ventana preguntarle.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use super::shared::db;
use crate::ipc::bridge::{ask_frontend_within, unwrap_frontend_result};
use crate::ipc::mcp::BROWSER_TIMEOUT_SECS;
use crate::ipc::protocol::arg_str;

pub(super) fn browser_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let request = args
        .get("request")
        .filter(|r| r.get("op").and_then(Value::as_str).is_some())
        .cloned()
        .ok_or_else(|| "Falta qué hacer en el navegador ('request.op')".to_string())?;

    let cwd = match args.get("cwd").and_then(Value::as_str) {
        Some(cwd) => cwd.to_string(),
        None => project_of_task(app, &arg_str(args, "taskId")?)?,
    };
    let window = window_with_folder(app, &cwd)?;

    let raw = ask_frontend_within(
        app,
        "browser.run",
        &json!({ "cwd": cwd, "request": request }),
        window.as_deref(),
        Duration::from_secs(browser_timeout(&request)),
    )?;
    unwrap_frontend_result(raw)
}

/// Cuánto puede tardar este pedido. Casi todos son de segundos; `pick` espera a que una
/// persona señale algo en la página, así que vale lo que el agente haya pedido esperar.
fn browser_timeout(request: &Value) -> u64 {
    if request.get("op").and_then(Value::as_str) != Some("pick") {
        return BROWSER_TIMEOUT_SECS;
    }
    let asked = request.get("timeout_s").and_then(Value::as_u64).unwrap_or(120).clamp(10, 600);
    asked + 30
}

/// La carpeta del PROYECTO de una tarea, no su cwd: una tarea aislada corre en un worktree,
/// pero el navegador que el usuario tiene abierto es el de la carpeta del proyecto.
fn project_of_task(app: &AppHandle, task_id: &str) -> Result<String, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT r.cwd FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?1",
        [task_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("No hay ninguna tarea con id {task_id}"))
}

/// Misma carpeta aunque una venga con la barra al final o, en Windows, con otras
/// barras y otra capitalización (el sistema de archivos ahí no distingue).
fn same_folder(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        if cfg!(windows) { p.to_lowercase() } else { p.to_string() }
    };
    norm(a) == norm(b)
}

/// La ventana abierta que tiene una tab en esa carpeta. `None` si ninguna la tiene
/// guardada todavía (una tab recién creada se escribe en la base con un rato de demora):
/// entonces se le pregunta a la primera, que con una sola ventana es la correcta.
fn window_with_folder(app: &AppHandle, cwd: &str) -> Result<Option<String>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT w.label, t.cwd FROM tabs t JOIN windows w ON w.id = t.window_id
             WHERE w.is_open = 1 ORDER BY w.last_active DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).find(|(_, tab_cwd)| same_folder(tab_cwd, cwd)).map(|(label, _)| label))
}
