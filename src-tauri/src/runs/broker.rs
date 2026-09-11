//! El que contesta los permisos que pide un agente headless.
//!
//! Cuando el agente quiere usar una herramienta que su modo de permisos no resuelve solo,
//! Claude Code llama a una tool MCP nuestra y **se queda esperando la respuesta**. Ese es
//! el circuito entero: lo que se conteste ahí decide si la herramienta corre o no.
//!
//! Lo verificado contra `claude 2.1.269`, porque todo el diseño se apoya en esto:
//!
//! - La tool recibe `{ tool_name, input, tool_use_id }`. Para un `Edit`, el `input` trae
//!   `file_path`/`old_string`/`new_string` — o sea el diff que muestra la tarjeta.
//! - Responde `{"behavior":"allow","updatedInput":{…}}` o `{"behavior":"deny","message":…}`.
//! - Con `deny` el archivo NO se toca y el agente lo dice en su respuesta.
//! - Las lecturas ni llegan acá: el modo de permisos ya las resuelve. Solo sube lo que de
//!   verdad hay que decidir.
//!
//! ## Por qué bloquea
//!
//! Mientras la app está abierta, se espera: que una persona decida ES el punto. El que
//! espera es el `ccode mcp` del agente, no la app — acá solo queda una entrada en la cola
//! y un `Condvar` al que se le avisa cuando hay decisión. Es el mismo patrón que
//! `orchestrator::watch::wait`, que ya hace long-polling para la CLI.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::rules::{self, Decision};

/// Lo que un agente está esperando que le contesten.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub task_id: String,
    pub tool_name: String,
    /// El `input` crudo de la herramienta. De acá sale el diff.
    pub input: serde_json::Value,
    pub asked_at: i64,
}

/// Lo que se le contesta.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub allow: bool,
    pub reason: Option<String>,
}

struct Waiting {
    pending: PendingApproval,
    verdict: Option<Verdict>,
}

lazy_static::lazy_static! {
    static ref QUEUE: Mutex<HashMap<String, Waiting>> = Mutex::new(HashMap::new());
    static ref DECIDED: Condvar = Condvar::new();
}

fn queue() -> MutexGuard<'static, HashMap<String, Waiting>> {
    QUEUE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Los pedidos que están esperando una persona ahora mismo.
pub fn pending() -> Vec<PendingApproval> {
    let mut rows: Vec<PendingApproval> =
        queue().values().filter(|w| w.verdict.is_none()).map(|w| w.pending.clone()).collect();
    rows.sort_by_key(|p| p.asked_at);
    rows
}

/// Registra el pedido y espera la decisión.
///
/// Devuelve `None` si venció el tiempo sin que nadie contestara. Quien llama decide qué
/// hacer con eso; acá no se inventa un veredicto, porque "nadie contestó" y "te dijeron
/// que no" son cosas distintas y el agente merece saber cuál fue.
pub fn ask(
    id: &str,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> Option<Verdict> {
    let id = id.to_string();
    let pending = PendingApproval {
        id: id.clone(),
        task_id: task_id.to_string(),
        tool_name: tool_name.to_string(),
        input,
        asked_at: now_ts(),
    };

    let mut q = queue();
    q.insert(id.clone(), Waiting { pending, verdict: None });
    drop(q);

    let mut q = queue();
    loop {
        match q.get(&id) {
            // Alguien decidió.
            Some(w) if w.verdict.is_some() => {
                let verdict = q.remove(&id).and_then(|w| w.verdict);
                return verdict;
            }
            // La entrada desapareció: la tarea se canceló o la app está cerrando.
            None => return None,
            Some(_) => {}
        }
        let (guard, wait) = DECIDED
            .wait_timeout(q, timeout)
            .unwrap_or_else(|e| e.into_inner());
        q = guard;
        if wait.timed_out() {
            q.remove(&id);
            return None;
        }
    }
}

/// Contesta un pedido. `false` si ya no existe (venció, o la tarea se canceló).
pub fn decide(id: &str, allow: bool, reason: Option<String>) -> bool {
    let mut q = queue();
    let Some(w) = q.get_mut(id) else { return false };
    w.verdict = Some(Verdict { allow, reason });
    drop(q);
    DECIDED.notify_all();
    true
}

/// Descarta lo que esté esperando de una tarea.
///
/// Se llama al cancelarla y al cerrar la app. Un pedido sin dueño no lo va a contestar
/// nadie nunca, y dejarlo en la cola lo mostraría en la consola para siempre.
pub fn drop_task(task_id: &str) -> usize {
    let mut q = queue();
    let ids: Vec<String> =
        q.values().filter(|w| w.pending.task_id == task_id).map(|w| w.pending.id.clone()).collect();
    for id in &ids {
        q.remove(id);
    }
    drop(q);
    if !ids.is_empty() {
        DECIDED.notify_all();
    }
    ids.len()
}

#[cfg(test)]
pub(crate) fn clear() {
    queue().clear();
}

// ── El circuito completo, con las reglas y la base ──────────────

/// Qué se le contesta a un agente que pide permiso.
///
/// Primero miran las reglas del run; solo lo que ninguna cubre sube a la consola. Sin eso,
/// cinco agentes llenan la pantalla de preguntas y el usuario termina apretando "sí" a
/// todo — que es peor que no haber preguntado.
pub fn resolve(
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> Verdict {
    let rules = rules_of_task(db, task_id);

    match rules::decide(&rules, tool_name, &input) {
        Decision::Allow => {
            record(db, task_id, tool_name, &input, Some(true), "rule");
            Verdict { allow: true, reason: None }
        }
        Decision::Deny => {
            record(db, task_id, tool_name, &input, Some(false), "rule");
            Verdict {
                allow: false,
                reason: Some("una regla de este run lo tiene denegado".into()),
            }
        }
        Decision::Ask => {
            let id = Uuid::new_v4().to_string();
            record_with_id(db, &id, task_id, tool_name, &input, None, "");
            let answered = ask(&id, task_id, tool_name, input, timeout);

            // Quién decidió queda anotado de verdad: un pedido que venció no fue una
            // decisión de nadie, y el registro de "qué le autorizaste a quién" no sirve si
            // le atribuye al usuario algo que no contestó.
            let by = if answered.is_some() { "user" } else { "timeout" };
            let verdict = answered.unwrap_or(Verdict {
                allow: false,
                // Se deniega, pero diciendo que fue por falta de respuesta y no por una
                // decisión: el agente lo repite en su salida, y "nadie contestó" es lo que
                // el usuario necesita leer ahí.
                reason: Some("nadie contestó el pedido de permiso a tiempo".into()),
            });

            close_row(db, &id, verdict.allow, verdict.reason.as_deref(), by);
            verdict
        }
    }
}

fn rules_of_task(db: &DbConnection, task_id: &str) -> Vec<rules::PermissionRule> {
    let Ok(conn) = db.lock() else { return Vec::new() };
    conn.query_row(
        "SELECT r.permission_rules FROM runs r JOIN tasks t ON t.run_id = r.id WHERE t.id = ?1",
        [task_id],
        |row| row.get::<_, String>(0),
    )
    .map(|json| rules::parse_rules(&json))
    .unwrap_or_default()
}

/// Deja el pedido anotado con un id ya elegido.
fn record_with_id(
    db: &DbConnection,
    id: &str,
    task_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
    allowed: Option<bool>,
    decided_by: &str,
) -> Option<()> {
    let now = now_ts();
    let (status, by, decided_at) = match allowed {
        Some(true) => ("allowed", Some(decided_by), Some(now)),
        Some(false) => ("denied", Some(decided_by), Some(now)),
        None => ("pending", None, None),
    };

    let conn = db.lock().ok()?;
    conn.execute(
        "INSERT INTO task_approvals (id, task_id, tool_name, input_json, status, decided_by,
                                     asked_at, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, task_id, tool_name, input.to_string(), status, by, now, decided_at],
    )
    .ok()?;
    Some(())
}

/// Lo mismo, para las decisiones que no pasan por la cola (las que resolvió una regla).
fn record(
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
    allowed: Option<bool>,
    decided_by: &str,
) {
    let id = Uuid::new_v4().to_string();
    record_with_id(db, &id, task_id, tool_name, input, allowed, decided_by);
}

fn close_row(db: &DbConnection, id: &str, allow: bool, reason: Option<&str>, by: &str) {
    let Ok(conn) = db.lock() else { return };
    let _ = conn.execute(
        "UPDATE task_approvals SET status = ?1, decided_by = ?2, reason = ?3, decided_at = ?4
         WHERE id = ?5",
        rusqlite::params![
            if allow { "allowed" } else { "denied" },
            by,
            reason,
            now_ts(),
            id,
        ],
    );
}

/// Cierra los pedidos que quedaron `pending` de una ejecución anterior de la app.
///
/// Igual que con las tareas colgadas: el agente que esperaba murió con la app, así que ese
/// pedido no lo va a contestar nadie. Dejarlo pendiente lo mostraría en la consola como si
/// todavía hiciera falta decidirlo.
pub fn sweep_orphans(db: &DbConnection) -> Result<usize, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE task_approvals SET status = 'denied', decided_by = 'timeout',
                                   reason = ?1, decided_at = ?2
         WHERE status = 'pending'",
        rusqlite::params!["la app se cerró antes de que se decidiera", now_ts()],
    )
    .map_err(|e| e.to_string())
}
