//! Las filas de `runs` y `tasks`: leerlas, crearlas y cerrarlas.
//!
//! A diferencia de las tabs —cuya fuente de verdad mientras la app corre es el store del
//! frontend— acá la base **es** la fuente de verdad: el proceso lo lanza y lo espera Rust,
//! así que no hay un store de Zustand que sepa nada que la base no sepa.

use rusqlite::{Connection, Row};
use uuid::Uuid;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::types::{status, Run, Task, TaskOutcome};

const RUN_COLUMNS: &str = "id, workspace_id, objective, cwd, status, max_parallel, budget_usd, \
                           spent_usd, created_at, ended_at";

const TASK_COLUMNS: &str = "id, run_id, title, prompt, agent_id, account_id, model, cwd, \
                            budget_usd, status, session_id, attempt, result, error, cost_usd, \
                            tokens_in, tokens_out, events_path, started_at, ended_at, created_at";

fn row_to_run(row: &Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        objective: row.get(2)?,
        cwd: row.get(3)?,
        status: row.get(4)?,
        max_parallel: row.get(5)?,
        budget_usd: row.get(6)?,
        spent_usd: row.get(7)?,
        created_at: row.get(8)?,
        ended_at: row.get(9)?,
    })
}

fn row_to_task(row: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        run_id: row.get(1)?,
        title: row.get(2)?,
        prompt: row.get(3)?,
        agent_id: row.get(4)?,
        account_id: row.get(5)?,
        model: row.get(6)?,
        cwd: row.get(7)?,
        budget_usd: row.get(8)?,
        status: row.get(9)?,
        session_id: row.get(10)?,
        attempt: row.get(11)?,
        result: row.get(12)?,
        error: row.get(13)?,
        cost_usd: row.get(14)?,
        tokens_in: row.get(15)?,
        tokens_out: row.get(16)?,
        events_path: row.get(17)?,
        started_at: row.get(18)?,
        ended_at: row.get(19)?,
        created_at: row.get(20)?,
    })
}

// ── Crear ───────────────────────────────────────────────────────

pub fn create_run(
    conn: &Connection,
    workspace_id: &str,
    objective: &str,
    cwd: &str,
) -> Result<Run, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    conn.execute(
        "INSERT INTO runs (id, workspace_id, objective, cwd, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
        rusqlite::params![id, workspace_id, objective, cwd, now],
    )
    .map_err(|e| e.to_string())?;
    run_by_id(conn, &id)?.ok_or_else(|| "el run no quedó guardado".to_string())
}

pub struct NewTask<'a> {
    pub run_id: &'a str,
    pub title: &'a str,
    pub prompt: &'a str,
    pub agent_id: &'a str,
    pub account_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub cwd: &'a str,
    pub budget_usd: Option<f64>,
}

pub fn create_task(conn: &Connection, new: &NewTask) -> Result<Task, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tasks (id, run_id, title, prompt, agent_id, account_id, model, cwd,
                            budget_usd, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            id,
            new.run_id,
            new.title,
            new.prompt,
            new.agent_id,
            new.account_id,
            new.model,
            new.cwd,
            new.budget_usd,
            status::READY,
            now_ts(),
        ],
    )
    .map_err(|e| e.to_string())?;
    task_by_id(conn, &id)?.ok_or_else(|| "la tarea no quedó guardada".to_string())
}

// ── Leer ────────────────────────────────────────────────────────

pub fn run_by_id(conn: &Connection, id: &str) -> Result<Option<Run>, String> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"), [id], row_to_run)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}

pub fn task_by_id(conn: &Connection, id: &str) -> Result<Option<Task>, String> {
    conn.query_row(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"), [id], row_to_task)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}

pub fn list_runs(conn: &Connection, workspace_id: &str) -> Result<Vec<Run>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], row_to_run)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Las tarjetas de un workspace, más recientes primero.
///
/// Se ordenan por creación y no por estado: el orden que importa —primero el que está
/// trabado— es cosa de la consola, que lo recalcula en vivo. Meterlo en el `ORDER BY`
/// obligaría a releer la base con cada cambio de estado.
pub fn list_tasks(conn: &Connection, workspace_id: &str) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM tasks t JOIN runs r ON r.id = t.run_id
             WHERE r.workspace_id = ?1 ORDER BY t.created_at DESC",
            TASK_COLUMNS.split(", ").map(|c| format!("t.{c}")).collect::<Vec<_>>().join(", ")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([workspace_id], row_to_task)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ── Cerrar ──────────────────────────────────────────────────────

/// La tarea arrancó: queda el id de sesión que se le impuso y dónde va su crudo.
pub fn mark_running(
    conn: &Connection,
    task_id: &str,
    session_id: &str,
    events_path: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status = ?1, session_id = ?2, events_path = ?3, started_at = ?4,
                          attempt = attempt + 1
         WHERE id = ?5",
        rusqlite::params![status::RUNNING, session_id, events_path, now_ts(), task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// La tarea cerró. Acumula lo gastado en su run, que es lo que mira el presupuesto.
///
/// Solo pisa filas abiertas (`ready` o `running`). Si el usuario canceló, el proceso muere
/// y el supervisor llega acá igual con un veredicto de fallo, y ese fallo no es de la tarea
/// sino de haberla parado: cancelada tiene que quedar cancelada. `ready` entra porque una
/// tarea que falla AL LANZARSE (un binario que no está, una cuenta borrada) nunca llegó a
/// correr, y sin eso se quedaría en `ready` para siempre.
pub fn finish_task(conn: &Connection, task_id: &str, outcome: &TaskOutcome) -> Result<(), String> {
    let state = if outcome.ok { status::DONE } else { status::FAILED };
    conn.execute(
        "UPDATE tasks SET status = ?1, result = ?2, error = ?3, cost_usd = ?4,
                          tokens_in = ?5, tokens_out = ?6, ended_at = ?7
         WHERE id = ?8 AND status IN ('ready', 'running')",
        rusqlite::params![
            state,
            outcome.result,
            outcome.error,
            outcome.cost_usd,
            outcome.tokens_in,
            outcome.tokens_out,
            now_ts(),
            task_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    if let Some(cost) = outcome.cost_usd {
        conn.execute(
            "UPDATE runs SET spent_usd = spent_usd + ?1
             WHERE id = (SELECT run_id FROM tasks WHERE id = ?2)",
            rusqlite::params![cost, task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cierra las tareas que quedaron `running` de una ejecución anterior de la app.
///
/// El proceso de una tarea es hijo de la app: cuando la app se va, se va con ella. Una
/// fila en `running` después de reabrir no es una tarea viva, es una que murió sin que
/// nadie llegara a anotarlo — y dejarla así la mostraría para siempre como si estuviera
/// trabajando. Corre en el arranque, junto al resto de la puesta a punto de la base.
pub fn sweep_orphans(db: &DbConnection) -> Result<usize, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE status = ?4",
            rusqlite::params![
                status::FAILED,
                "la app se cerró mientras esta tarea corría",
                now_ts(),
                status::RUNNING,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}
