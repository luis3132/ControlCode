//! Agentes headless: los que corren sin terminal y sin que nadie los mire.
//!
//! Un agente de una tab es un PTY que el usuario mira y tipea. Uno de acá es un proceso
//! con el stdout redirigido del que la app es dueña de punta a punta: emite eventos
//! estructurados en vez de pixeles, así que qué archivo tocó, cuánto costó y si terminó
//! bien vienen **como datos** y no hay que inferirlos de una pantalla redibujada.
//!
//! Eso es lo que hace posible la consola de flota: ver de un vistazo qué está haciendo
//! cada agente. La capa de `orchestrator::{digest,cursors,watch}` sigue siendo para las
//! tabs interactivas y no se toca — acá no hace falta comprimir nada.

mod activity;
mod agents;
mod broker;
mod rules;
mod store;
mod supervisor;
mod types;
#[cfg(test)]
mod test;

pub use store::sweep_orphans;
pub use types::{Run, Task};

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

fn db_of(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone())
}

/// Las tarjetas de un workspace, más recientes primero.
#[tauri::command]
pub fn run_list_tasks(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_tasks(&conn, &workspace_id)
}

#[tauri::command]
pub fn run_list_runs(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Run>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_runs(&conn, &workspace_id)
}

/// Crea la tarea y la lanza.
///
/// Por ahora cada lanzamiento abre su propio run. Cuando entre el DAG, un run pasará a
/// agrupar varias tareas con sus dependencias; la forma ya está para eso.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn run_start_task(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    title: String,
    prompt: String,
    agent_id: String,
    account_id: Option<String>,
    model: Option<String>,
    budget_usd: Option<f64>,
) -> Result<Task, String> {
    let db = db_of(&app)?;
    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let run = store::create_run(&conn, &workspace_id, &title, &cwd)?;
        store::create_task(
            &conn,
            &store::NewTask {
                run_id: &run.id,
                title: &title,
                prompt: &prompt,
                agent_id: &agent_id,
                account_id: account_id.as_deref(),
                model: model.as_deref(),
                cwd: &cwd,
                budget_usd,
            },
        )?
    };

    // Si el lanzamiento falla, la fila queda igual pero como fallida: una tarea que
    // desaparece sin dejar rastro no se puede diagnosticar, y el motivo (un binario que
    // no está, una cuenta borrada) es justo lo que hay que mostrar.
    if let Err(e) = supervisor::start(&app, task.clone()) {
        let conn = db.lock().map_err(|err| err.to_string())?;
        store::finish_task(&conn, &task.id, &types::TaskOutcome::failed(e.clone()))?;
        return Err(e);
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al lanzarla".into())
}

#[tauri::command]
pub fn run_cancel_task(app: AppHandle, task_id: String) -> Result<(), String> {
    supervisor::cancel(&app, &task_id)
}

// ── Permisos ────────────────────────────────────────────────────

/// Lo que el puente MCP de una tarea pregunta: ¿puede usar esta herramienta?
///
/// Vive acá y no en `broker` porque además de resolverlo hay que avisarle a la consola: un
/// pedido que espera y nadie ve es un agente parado en silencio.
pub fn resolve_permission(
    app: &AppHandle,
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> broker::Verdict {
    supervisor::notify_approvals(app);
    let verdict = broker::resolve(db, task_id, tool_name, input, timeout);
    // Y otra vez al cerrarse, para que la tarjeta deje de pedir.
    supervisor::notify_approvals(app);
    verdict
}

/// Los pedidos que están esperando a una persona ahora mismo.
#[tauri::command]
pub fn run_pending_approvals() -> Vec<broker::PendingApproval> {
    broker::pending()
}

/// Contesta un pedido. `false` si ya no existe: venció, o la tarea se canceló mientras
/// tanto, y en los dos casos el usuario tiene que enterarse en vez de creer que decidió.
#[tauri::command]
pub fn run_decide_approval(
    app: AppHandle,
    approval_id: String,
    allow: bool,
    reason: Option<String>,
) -> Result<bool, String> {
    let decided = broker::decide(&approval_id, allow, reason);
    supervisor::notify_approvals(&app);
    Ok(decided)
}

/// Las reglas de permisos de un run.
#[tauri::command]
pub fn run_set_permission_rules(
    run_id: String,
    rules: Vec<rules::PermissionRule>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let json = serde_json::to_string(&rules).map_err(|e| e.to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE runs SET permission_rules = ?1 WHERE id = ?2", rusqlite::params![json, run_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cierra los pedidos que quedaron colgados de una ejecución anterior de la app.
pub fn sweep_orphan_approvals(db: &DbConnection) -> Result<usize, String> {
    broker::sweep_orphans(db)
}
