//! Qué tarea de un run arranca ahora, y qué pasa cuando una termina.
//!
//! La decisión es una función pura (`decide`) sobre la foto del run: qué tareas esperan, de
//! qué dependen y cuánto lugar queda. Lo que la ejecuta (`tick`) toma esa foto bajo el lock
//! de la base, marca las elegidas antes de soltarlo y recién después las lanza — así dos
//! ticks seguidos no despachan la misma tarea dos veces.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

use super::store;
use super::types::{role, status, Run, Task};

#[derive(Debug, Default, PartialEq)]
pub struct Decision {
    /// Las que arrancan, en orden.
    pub launch: Vec<String>,
    /// Las que no van a correr, con el motivo.
    pub skip: Vec<(String, String)>,
}

/// El lead no ocupa lugar: está esperando a sus workers, y contarlo dejaría a un run con
/// `max_parallel = 2` corriendo de a una tarea.
fn occupies_slot(task: &Task) -> bool {
    matches!(task.status.as_str(), status::READY | status::RUNNING) && task.role.as_deref() != Some(role::LEAD)
}

fn label(task: &Task) -> String {
    task.plan_key.clone().unwrap_or_else(|| task.title.clone())
}

pub fn decide(run: &Run, tasks: &[Task]) -> Decision {
    let mut decision = Decision::default();
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let running = tasks.iter().filter(|t| occupies_slot(t)).count() as i64;
    let mut free = (run.max_parallel.max(1) - running).max(0);
    let over_budget = run.budget_usd.is_some_and(|b| run.spent_usd >= b);

    for task in tasks.iter().filter(|t| t.status == status::PENDING) {
        let mut waiting = false;
        let mut broken = None;
        for dep in &task.depends_on {
            match by_id.get(dep.as_str()) {
                Some(d) if d.status == status::DONE => {}
                Some(d) if status::is_final(&d.status) => {
                    broken = Some(format!("depende de '{}', que terminó como {}", label(d), d.status));
                    break;
                }
                Some(_) => waiting = true,
                // Una dependencia que ya no existe (se borró su fila) no se va a cumplir nunca.
                None => {
                    broken = Some("depende de una tarea que ya no existe".to_string());
                    break;
                }
            }
        }
        if let Some(reason) = broken {
            decision.skip.push((task.id.clone(), reason));
            continue;
        }
        if waiting {
            continue;
        }
        if over_budget {
            decision.skip.push((task.id.clone(), "se acabó el presupuesto del run".to_string()));
            continue;
        }
        if free > 0 {
            decision.launch.push(task.id.clone());
            free -= 1;
        }
    }
    decision
}

/// Un fallo que vale la pena reintentar: el agente llegó a correr y no fue por plata. Un
/// binario que no está o un presupuesto agotado fallan igual la segunda vez, y cobran dos.
pub fn should_retry(task: &Task) -> bool {
    task.role.as_deref() == Some(role::WORKER)
        && task.status == status::FAILED
        && task.attempt < 2
        && task.session_id.is_some()
        && !task.error.as_deref().is_some_and(|e| e.contains("budget"))
}

// ── La parte con efectos ────────────────────────────────────────

lazy_static::lazy_static! {
    /// Un tick a la vez. Con dos en paralelo sobre el mismo run, los dos verían el mismo
    /// lugar libre antes de que el otro marcara su tarea.
    static ref TICK: Mutex<()> = Mutex::new(());
    /// Cuántas veces cambió cada run. `run_await` espera a que el número se mueva.
    static ref CHANGES: (Mutex<HashMap<String, u64>>, Condvar) = (Mutex::new(HashMap::new()), Condvar::new());
}

/// Anota que el run cambió y despierta a quien esté esperando.
pub fn bump(run_id: &str) {
    let (lock, cvar) = &*CHANGES;
    if let Ok(mut map) = lock.lock() {
        *map.entry(run_id.to_string()).or_insert(0) += 1;
    }
    cvar.notify_all();
}

pub fn version(run_id: &str) -> u64 {
    CHANGES.0.lock().map(|m| m.get(run_id).copied().unwrap_or(0)).unwrap_or(0)
}

/// Espera a que el run cambie después de `seen`, hasta `timeout`. Devuelve la versión nueva.
pub fn wait_change(run_id: &str, seen: u64, timeout: Duration) -> u64 {
    let (lock, cvar) = &*CHANGES;
    let deadline = Instant::now() + timeout;
    let Ok(mut map) = lock.lock() else { return seen };
    loop {
        let current = map.get(run_id).copied().unwrap_or(0);
        if current != seen {
            return current;
        }
        let now = Instant::now();
        if now >= deadline {
            return current;
        }
        match cvar.wait_timeout(map, deadline - now) {
            Ok((guard, _)) => map = guard,
            Err(_) => return seen,
        }
    }
}

fn db_of(app: &AppHandle) -> Option<DbConnection> {
    app.try_state::<DbConnection>().map(|s| s.inner().clone())
}

/// Despacha lo que le toque al run y cierra lo que ya no va a correr.
pub fn tick(app: &AppHandle, run_id: &str) {
    let Some(db) = db_of(app) else { return };
    let _one = TICK.lock().unwrap_or_else(|e| e.into_inner());

    let (to_launch, skipped) = {
        let Ok(conn) = db.lock() else { return };
        let Ok(Some(run)) = store::run_by_id(&conn, run_id) else { return };
        let Ok(tasks) = store::tasks_of_run(&conn, run_id) else { return };
        let decision = decide(&run, &tasks);

        let mut skipped = Vec::new();
        for (id, reason) in &decision.skip {
            if store::skip_task(&conn, id, reason).unwrap_or(false) {
                skipped.push(id.clone());
            }
        }
        let mut to_launch = Vec::new();
        for id in &decision.launch {
            // Se marca adentro del lock: el próximo tick ya la ve ocupando lugar.
            if store::mark_dispatched(&conn, id).unwrap_or(false)
                && let Ok(Some(task)) = store::task_by_id(&conn, id)
            {
                to_launch.push(task);
            }
        }
        let _ = store::refresh_run_status(&conn, run_id);
        (to_launch, skipped)
    };

    for id in &skipped {
        super::supervisor::notify_changed(app, id);
    }
    // Saltear una tarea puede dejar sin cumplir a las que dependían de ella, y una que no se
    // pudo lanzar libera su lugar: en los dos casos hay que volver a mirar el run.
    let mut again = !skipped.is_empty();
    for task in to_launch {
        again |= !super::launch_planned(app, &db, task);
    }
    if let Ok(conn) = db.lock() {
        let _ = store::refresh_run_status(&conn, run_id);
    }
    bump(run_id);
    drop(_one);
    if again {
        tick(app, run_id);
    }
}

/// Una tarea de un run terminó: reintentarla si corresponde, y ver qué más arranca.
pub fn on_task_finished(app: &AppHandle, task_id: &str) {
    let Some(db) = db_of(app) else { return };
    let run_id = {
        let Ok(conn) = db.lock() else { return };
        let Ok(Some(task)) = store::task_by_id(&conn, task_id) else { return };
        if should_retry(&task) {
            let error = task.error.clone().unwrap_or_default();
            let _ = store::requeue_for_retry(&conn, task_id, &error);
        }
        task.run_id
    };
    super::supervisor::notify_changed(app, task_id);
    tick(app, &run_id);
}
