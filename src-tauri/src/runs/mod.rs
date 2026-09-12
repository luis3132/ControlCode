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
///
/// Con `remember`, además deja escrita la regla exacta del pedido para su carpeta, y
/// resuelve con ella lo que otros agentes de esa carpeta estuvieran esperando.
#[tauri::command]
pub fn run_decide_approval(
    app: AppHandle,
    approval_id: String,
    allow: bool,
    remember: bool,
    db: tauri::State<DbConnection>,
) -> Result<bool, String> {
    let Some(pending) = broker::get(&approval_id) else {
        supervisor::notify_approvals(&app);
        return Ok(false);
    };

    // La regla se guarda ANTES de contestar: si guardarla falla, el usuario tiene que
    // enterarse ahí, no después de que el agente ya siguió creyendo que quedó recordado.
    let remembered_in = if remember {
        remember_rule(&db, &pending, allow)?
    } else {
        None
    };

    let decided = broker::decide(&approval_id, allow, None);
    if let Some(cwd) = remembered_in {
        broker::release_matching(&db, &cwd);
    }
    supervisor::notify_approvals(&app);
    Ok(decided)
}

/// Guarda la regla exacta de un pedido. Devuelve la carpeta en la que quedó.
fn remember_rule(
    db: &DbConnection,
    pending: &broker::PendingApproval,
    allow: bool,
) -> Result<Option<String>, String> {
    // Un pedido sin regla exacta posible no ofrece "recordar" en la consola; si igual llega
    // acá (un click contra una tarjeta vieja), se contesta sin recordar en vez de inventar
    // una regla más amplia que lo que se vio.
    let Some(pattern) = rules::exact_rule_for(&pending.tool_name, &pending.input) else {
        return Ok(None);
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    let Some(cwd) = store::project_cwd_of_task(&conn, &pending.task_id) else {
        return Ok(None);
    };
    store::upsert_rule(&conn, &cwd, &pattern, allow)?;
    Ok(Some(cwd))
}

/// Las reglas de una carpeta, en el orden en que se evalúan.
#[tauri::command]
pub fn run_list_rules(cwd: String, db: tauri::State<DbConnection>) -> Result<Vec<store::RuleRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_rules(&conn, &cwd)
}

/// Agrega una regla escrita a mano, y resuelve con ella lo que estuviera esperando.
#[tauri::command]
pub fn run_add_rule(
    app: AppHandle,
    cwd: String,
    pattern: String,
    allow: bool,
    db: tauri::State<DbConnection>,
) -> Result<store::RuleRow, String> {
    if !rules::is_valid_pattern(&pattern) {
        return Err(format!(
            "'{pattern}' no tiene la forma de una regla: Herramienta o Herramienta(patrón)"
        ));
    }
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::upsert_rule(&conn, &cwd, &pattern, allow)?
    };
    if broker::release_matching(&db, &cwd) > 0 {
        supervisor::notify_approvals(&app);
    }
    Ok(row)
}

#[tauri::command]
pub fn run_delete_rule(id: String, db: tauri::State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::delete_rule(&conn, &id)
}

/// Cierra los pedidos que quedaron colgados de una ejecución anterior de la app.
pub fn sweep_orphan_approvals(db: &DbConnection) -> Result<usize, String> {
    broker::sweep_orphans(db)
}
