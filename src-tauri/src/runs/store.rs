//! Las filas de `runs` y `tasks`: leerlas, crearlas y cerrarlas.
//!
//! A diferencia de las tabs —cuya fuente de verdad mientras la app corre es el store del
//! frontend— acá la base **es** la fuente de verdad: el proceso lo lanza y lo espera Rust,
//! así que no hay un store de Zustand que sepa nada que la base no sepa.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use uuid::Uuid;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::types::{status, Fact, Run, Task, TaskOutcome};

const RUN_COLUMNS: &str = "id, workspace_id, objective, cwd, status, max_parallel, budget_usd, \
                           spent_usd, created_at, ended_at";

const TASK_COLUMNS: &str = "id, run_id, title, prompt, agent_id, account_id, model, cwd, \
                            budget_usd, status, session_id, attempt, result, error, cost_usd, \
                            tokens_in, tokens_out, events_path, started_at, ended_at, created_at, \
                            worktree_path, branch, worktree_removed, complexity, routed_by, \
                            route_note, role, plan_key, parent_id, depth, isolate, result_schema, \
                            last_error";

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
        worktree_path: row.get(21)?,
        branch: row.get(22)?,
        worktree_removed: row.get::<_, i64>(23)? != 0,
        complexity: row.get(24)?,
        routed_by: row.get(25)?,
        route_note: row.get(26)?,
        role: row.get(27)?,
        plan_key: row.get(28)?,
        parent_id: row.get(29)?,
        depth: row.get(30)?,
        isolate: row.get::<_, i64>(31)? != 0,
        result_schema: row.get(32)?,
        last_error: row.get(33)?,
        // Lo llena `with_deps`: vive en otra tabla.
        depends_on: Vec::new(),
    })
}

/// Completa `depends_on` de cada tarea con una sola consulta por lote.
fn with_deps(conn: &Connection, mut tasks: Vec<Task>) -> Result<Vec<Task>, String> {
    if tasks.is_empty() {
        return Ok(tasks);
    }
    let placeholders = vec!["?"; tasks.len()].join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT task_id, depends_on FROM task_deps WHERE task_id IN ({placeholders}) ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let pairs: Vec<(String, String)> = stmt
        .query_map(rusqlite::params_from_iter(ids), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for task in &mut tasks {
        task.depends_on = pairs.iter().filter(|(t, _)| *t == task.id).map(|(_, d)| d.clone()).collect();
    }
    Ok(tasks)
}

// ── Crear ───────────────────────────────────────────────────────

pub fn create_run(
    conn: &Connection,
    workspace_id: &str,
    objective: &str,
    cwd: &str,
) -> Result<Run, String> {
    create_run_with(conn, workspace_id, objective, cwd, 2, None)
}

/// Un run con su paralelismo y su presupuesto: lo que declara un plan.
pub fn create_run_with(
    conn: &Connection,
    workspace_id: &str,
    objective: &str,
    cwd: &str,
    max_parallel: i64,
    budget_usd: Option<f64>,
) -> Result<Run, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ts();
    conn.execute(
        "INSERT INTO runs (id, workspace_id, objective, cwd, status, max_parallel, budget_usd, created_at)
         VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7)",
        rusqlite::params![id, workspace_id, objective, cwd, max_parallel, budget_usd, now],
    )
    .map_err(|e| e.to_string())?;
    run_by_id(conn, &id)?.ok_or_else(|| "el run no quedó guardado".to_string())
}

#[derive(Default)]
pub struct NewTask<'a> {
    pub run_id: &'a str,
    pub title: &'a str,
    pub prompt: &'a str,
    pub agent_id: &'a str,
    pub account_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub cwd: &'a str,
    pub budget_usd: Option<f64>,
    pub complexity: Option<&'a str>,
    pub routed_by: Option<&'a str>,
    pub route_note: Option<&'a str>,
    /// `None` = lanzada a mano.
    pub role: Option<&'a str>,
    pub plan_key: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub depth: i64,
    pub isolate: bool,
    pub result_schema: Option<&'a str>,
    /// Arranca esperando (`pending`) en vez de lista para lanzar. Es lo que crea un plan: la
    /// tarea existe, pero la lanza el scheduler cuando le toca.
    pub queued: bool,
}

pub fn create_task(conn: &Connection, new: &NewTask) -> Result<Task, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tasks (id, run_id, title, prompt, agent_id, account_id, model, cwd,
                            budget_usd, status, created_at, complexity, routed_by, route_note,
                            role, plan_key, parent_id, depth, isolate, result_schema)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
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
            if new.queued { status::PENDING } else { status::READY },
            now_ts(),
            new.complexity,
            new.routed_by,
            new.route_note,
            new.role,
            new.plan_key,
            new.parent_id,
            new.depth,
            new.isolate as i64,
            new.result_schema,
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
    let task = conn
        .query_row(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"), [id], row_to_task)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match task {
        Some(t) => with_deps(conn, vec![t])?.pop(),
        None => None,
    })
}

/// Las tareas de un run, en el orden en que se crearon: el orden del plan.
pub fn tasks_of_run(conn: &Connection, run_id: &str) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE run_id = ?1 ORDER BY created_at, rowid"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], row_to_task)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    with_deps(conn, rows)
}

/// Una tarea del run por su nombre en el plan o por su id.
pub fn task_in_run(conn: &Connection, run_id: &str, key_or_id: &str) -> Result<Option<Task>, String> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM tasks WHERE run_id = ?1 AND (id = ?2 OR plan_key = ?2) ORDER BY created_at LIMIT 1",
            [run_id, key_or_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match id {
        Some(id) => task_by_id(conn, &id),
        None => Ok(None),
    }
}

pub fn run_of_task(conn: &Connection, task_id: &str) -> Result<Option<Run>, String> {
    let run_id: Option<String> = conn
        .query_row("SELECT run_id FROM tasks WHERE id = ?1", [task_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match run_id {
        Some(id) => run_by_id(conn, &id),
        None => Ok(None),
    }
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
    with_deps(conn, rows)
}

/// El workspace de una carpeta: el de la ventana abierta más reciente que tiene una tab ahí.
/// Es cómo un agente de una tab, que solo conoce su carpeta, crea un run donde se vea.
pub fn workspace_of_folder(conn: &Connection, cwd: &str) -> Option<String> {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();
    let wanted = norm(cwd);
    let mut stmt = conn
        .prepare(
            "SELECT w.workspace_id, t.cwd FROM tabs t JOIN windows w ON w.id = t.window_id
             ORDER BY w.is_open DESC, w.last_active DESC",
        )
        .ok()?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()?;
    // En una variable a propósito: devolverlo directo haría vivir el iterador (que toma
    // prestado `stmt`) más que `stmt` mismo.
    #[allow(clippy::let_and_return)]
    let found = rows.filter_map(Result::ok).find(|(_, c)| norm(c) == wanted).map(|(w, _)| w);
    found
}

/// El run más reciente creado desde esa carpeta en ese workspace.
pub fn latest_run_in_folder(conn: &Connection, workspace_id: &str, cwd: &str) -> Result<Option<Run>, String> {
    conn.query_row(
        &format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE workspace_id = ?1 AND cwd = ?2
             ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ),
        [workspace_id, cwd],
        row_to_run,
    )
    .optional()
    .map_err(|e| e.to_string())
}

// ── El plan ─────────────────────────────────────────────────────

pub fn add_dep(conn: &Connection, task_id: &str, depends_on: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?1, ?2)",
        [task_id, depends_on],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cambia el paralelismo o el presupuesto de un run, si vienen.
pub fn update_run_limits(conn: &Connection, run_id: &str, max_parallel: Option<i64>, budget_usd: Option<f64>) -> Result<(), String> {
    if let Some(n) = max_parallel {
        conn.execute("UPDATE runs SET max_parallel = ?1 WHERE id = ?2", rusqlite::params![n, run_id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(b) = budget_usd {
        conn.execute("UPDATE runs SET budget_usd = ?1 WHERE id = ?2", rusqlite::params![b, run_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancela una tarea que todavía esperaba turno.
pub fn cancel_one_pending(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, ended_at = ?2 WHERE id = ?3 AND status = ?4",
            rusqlite::params![status::CANCELLED, now_ts(), task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn set_run_objective(conn: &Connection, run_id: &str, objective: &str) -> Result<(), String> {
    conn.execute("UPDATE runs SET objective = ?1 WHERE id = ?2", [objective, run_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Le toca correr: de `pending` a `ready`. `false` si otro ya la despachó o se canceló.
pub fn mark_dispatched(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1 WHERE id = ?2 AND status = ?3",
            rusqlite::params![status::READY, task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// No va a correr, y por qué. Solo sobre tareas que esperaban.
pub fn skip_task(conn: &Connection, task_id: &str, reason: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE id = ?4 AND status = ?5",
            rusqlite::params![status::SKIPPED, reason, now_ts(), task_id, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Vuelve a la cola para un segundo intento, con el motivo del primero.
pub fn requeue_for_retry(conn: &Connection, task_id: &str, error: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, last_error = ?2, error = NULL, result = NULL,
                              ended_at = NULL, session_id = NULL
             WHERE id = ?3 AND status = ?4",
            rusqlite::params![status::PENDING, error, task_id, status::FAILED],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Cancela lo que esperaba en un run. Devuelve cuántas.
pub fn cancel_pending(conn: &Connection, run_id: &str, reason: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE run_id = ?4 AND status = ?5",
        rusqlite::params![status::CANCELLED, reason, now_ts(), run_id, status::PENDING],
    )
    .map_err(|e| e.to_string())
}

/// Recalcula el estado del run a partir de sus tareas y lo guarda. Devuelve el nuevo.
///
/// `running` mientras quede algo que pueda cambiar solo; al cerrarse todo, `done` si todas
/// terminaron bien, `cancelled` si alguna se canceló y ninguna falló, y `failed` si no.
pub fn refresh_run_status(conn: &Connection, run_id: &str) -> Result<String, String> {
    let statuses: Vec<String> = {
        let mut stmt = conn.prepare("SELECT status FROM tasks WHERE run_id = ?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([run_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let next = if statuses.iter().any(|s| !status::is_final(s)) {
        "running"
    } else if statuses.iter().all(|s| s == status::DONE) {
        "done"
    } else if statuses.iter().any(|s| s == status::FAILED || s == status::SKIPPED) {
        "failed"
    } else {
        "cancelled"
    };
    conn.execute(
        "UPDATE runs SET status = ?1,
                         ended_at = CASE WHEN ?1 = 'running' THEN NULL ELSE COALESCE(ended_at, ?2) END
         WHERE id = ?3",
        rusqlite::params![next, now_ts(), run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(next.to_string())
}

// ── Lo que se dejan escrito ─────────────────────────────────────

pub fn add_fact(conn: &Connection, run_id: &str, task_id: Option<&str>, kind: &str, body: &str) -> Result<Fact, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO run_facts (id, run_id, task_id, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, run_id, task_id, kind, body, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    facts_of_run(conn, run_id)?
        .into_iter()
        .find(|f| f.id == id)
        .ok_or_else(|| "el hecho no quedó guardado".to_string())
}

pub fn facts_of_run(conn: &Connection, run_id: &str) -> Result<Vec<Fact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.run_id, f.task_id, t.title, f.kind, f.body, f.created_at
             FROM run_facts f LEFT JOIN tasks t ON t.id = f.task_id
             WHERE f.run_id = ?1 ORDER BY f.created_at, f.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok(Fact {
                id: r.get(0)?,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                author: r.get(3)?,
                kind: r.get(4)?,
                body: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ── Cerrar ──────────────────────────────────────────────────────

/// La tarea corre en un worktree: su `cwd` pasa a ser el de adentro.
pub fn set_worktree(conn: &Connection, task_id: &str, cwd: &str, root: &str, branch: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET cwd = ?1, worktree_path = ?2, branch = ?3 WHERE id = ?4",
        rusqlite::params![cwd, root, branch, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `(carpeta del proyecto, cwd de la tarea, raíz del worktree)`, si corre en uno.
pub fn worktree_of_task(conn: &Connection, task_id: &str) -> Option<(String, String, String)> {
    conn.query_row(
        "SELECT r.cwd, t.cwd, t.worktree_path FROM tasks t JOIN runs r ON r.id = t.run_id
         WHERE t.id = ?1 AND t.worktree_path IS NOT NULL",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn mark_worktree_removed(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute("UPDATE tasks SET worktree_removed = 1 WHERE id = ?1", [task_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

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
        // Costo y tokens SUMAN: con reintentos, la tarea gastó lo de todos sus intentos, y
        // mostrar solo el último escondería lo que costó que fallara la primera vez.
        "UPDATE tasks SET status = ?1, result = ?2, error = ?3,
                          cost_usd = CASE WHEN ?4 IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ?4 END,
                          tokens_in = CASE WHEN ?5 IS NULL THEN tokens_in ELSE COALESCE(tokens_in, 0) + ?5 END,
                          tokens_out = CASE WHEN ?6 IS NULL THEN tokens_out ELSE COALESCE(tokens_out, 0) + ?6 END,
                          ended_at = ?7
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
    let now = now_ts();
    let n = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE status IN ('ready', 'running')",
            rusqlite::params![status::FAILED, "la app se cerró mientras esta tarea corría", now],
        )
        .map_err(|e| e.to_string())?;
    // Las que esperaban turno no se relanzan solas al reabrir: su lead murió con la app, y
    // un plan a medias corriendo sin nadie que lo mire no es lo que alguien dejó andando.
    let waiting = conn
        .execute(
            "UPDATE tasks SET status = ?1, error = ?2, ended_at = ?3 WHERE status = ?4",
            rusqlite::params![status::CANCELLED, "la app se cerró antes de que le tocara correr", now, status::PENDING],
        )
        .map_err(|e| e.to_string())?;
    let open_runs: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM runs WHERE status = 'running'").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for run in open_runs {
        refresh_run_status(&conn, &run)?;
    }
    Ok(n + waiting)
}

// ── Reglas de permisos ──────────────────────────────────────────

/// Una regla tal como se guarda y como la ve la consola.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleRow {
    pub id: String,
    pub cwd: String,
    pub pattern: String,
    pub allow: bool,
    pub created_at: i64,
}

/// La carpeta de proyecto de una tarea: la de su run, no la suya.
///
/// Hoy coinciden. Cuando las tareas corran en worktrees, cada una va a tener su propio
/// cwd, y las reglas tienen que seguir siendo las del proyecto desde el que se lanzaron.
pub fn project_cwd_of_task(conn: &Connection, task_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT r.cwd FROM runs r JOIN tasks t ON t.run_id = r.id WHERE t.id = ?1",
        [task_id],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Las reglas de una carpeta, en el orden en que se evalúan.
///
/// Por creación, con el `rowid` de desempate: dos reglas creadas en el mismo segundo
/// tienen que salir siempre en el mismo orden, porque con "gana la primera que coincide"
/// un orden inestable es un resultado inestable.
pub fn list_rules(conn: &Connection, cwd: &str) -> Result<Vec<RuleRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, pattern, allow, created_at FROM permission_rules
             WHERE cwd = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([cwd], |row| {
            Ok(RuleRow {
                id: row.get(0)?,
                cwd: row.get(1)?,
                pattern: row.get(2)?,
                allow: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Guarda una regla. Si ya había una con el mismo patrón en esa carpeta, le cambia el
/// veredicto **sin moverla de lugar**.
///
/// No moverla importa: el orden decide con "gana la primera", y darle vuelta a una regla
/// que ya existía no debería cambiar su precedencia respecto de las demás a espaldas del
/// usuario.
pub fn upsert_rule(conn: &Connection, cwd: &str, pattern: &str, allow: bool) -> Result<RuleRow, String> {
    let pattern = pattern.trim();
    conn.execute(
        "INSERT INTO permission_rules (id, cwd, pattern, allow, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(cwd, pattern) DO UPDATE SET allow = excluded.allow",
        rusqlite::params![Uuid::new_v4().to_string(), cwd, pattern, allow as i64, now_ts()],
    )
    .map_err(|e| e.to_string())?;

    list_rules(conn, cwd)?
        .into_iter()
        .find(|r| r.pattern == pattern)
        .ok_or_else(|| "la regla no quedó guardada".to_string())
}

pub fn delete_rule(conn: &Connection, id: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM permission_rules WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}
