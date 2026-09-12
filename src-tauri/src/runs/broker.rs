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
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::rules::{self, Decision, PermissionRule};
use super::store;

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
    /// La regla que dejaría escrita "recordar", tal cual se va a guardar. `None` = para
    /// este pedido no se ofrece (ver `rules::exact_rule_for`). Viaja ya armada para que la
    /// consola muestre EXACTAMENTE lo que se va a recordar, en vez de describirlo.
    pub suggested_rule: Option<String>,
}

/// Quién resolvió un pedido. Es lo que queda en `task_approvals.decided_by`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DecidedBy {
    User,
    Rule,
    /// Nadie contestó a tiempo.
    Timeout,
    /// La tarea se canceló (o la app se cerró) mientras esperaba.
    Cancelled,
}

impl DecidedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            DecidedBy::User => "user",
            DecidedBy::Rule => "rule",
            DecidedBy::Timeout => "timeout",
            DecidedBy::Cancelled => "cancelled",
        }
    }
}

/// Lo que se le contesta al agente, y quién lo decidió.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub allow: bool,
    pub reason: Option<String>,
    pub by: DecidedBy,
}

const RULE_DENIED: &str = "una regla de esta carpeta lo tiene denegado";

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

/// Un pedido que sigue esperando, por id.
pub fn get(id: &str) -> Option<PendingApproval> {
    queue().get(id).filter(|w| w.verdict.is_none()).map(|w| w.pending.clone())
}

/// Registra el pedido y espera la decisión.
///
/// Siempre devuelve un veredicto, y el `by` dice de dónde salió. Que un pedido venza se
/// traduce en denegar — el agente corre sin que nadie lo mire, y ante la duda no toca
/// nada — pero anotado como `Timeout` y no como decisión de nadie: "nadie contestó" y
/// "te dijeron que no" son cosas distintas, y el agente las repite en su salida.
pub fn ask(
    id: &str,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> Verdict {
    let id = id.to_string();
    let pending = PendingApproval {
        id: id.clone(),
        task_id: task_id.to_string(),
        tool_name: tool_name.to_string(),
        suggested_rule: rules::exact_rule_for(tool_name, &input),
        input,
        asked_at: now_ts(),
    };

    // Fecha límite fija, no un `timeout` que se renueva. `notify_all` despierta a TODOS
    // los que esperan cada vez que se decide cualquier pedido, así que con un
    // `wait_timeout(timeout)` en cada vuelta el plazo de un agente volvía a empezar de cero
    // cada vez que se contestaba el de otro — y con varios agentes activos no vencía nunca.
    let deadline = Instant::now() + timeout;

    let mut q = queue();
    q.insert(id.clone(), Waiting { pending, verdict: None });

    loop {
        match q.get(&id) {
            Some(w) if w.verdict.is_some() => {
                return q.remove(&id).and_then(|w| w.verdict).expect("recién comprobado");
            }
            // La entrada desapareció sin veredicto: la tarea se canceló o la app cierra.
            None => {
                return Verdict {
                    allow: false,
                    reason: Some("la tarea se canceló mientras esperaba".into()),
                    by: DecidedBy::Cancelled,
                };
            }
            Some(_) => {}
        }

        let now = Instant::now();
        if now >= deadline {
            q.remove(&id);
            return Verdict {
                allow: false,
                reason: Some("nadie contestó el pedido de permiso a tiempo".into()),
                by: DecidedBy::Timeout,
            };
        }
        let (guard, _) = DECIDED
            .wait_timeout(q, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        q = guard;
    }
}

fn decide_with(id: &str, verdict: Verdict) -> bool {
    let mut q = queue();
    let Some(w) = q.get_mut(id) else { return false };
    if w.verdict.is_some() {
        // Ya lo resolvió otro (una regla nueva, o un segundo click): la primera respuesta
        // es la que el agente ya está leyendo, y no se le cambia por debajo.
        return false;
    }
    w.verdict = Some(verdict);
    drop(q);
    DECIDED.notify_all();
    true
}

/// Contesta un pedido como decisión de una persona. `false` si ya no existe (venció, o la
/// tarea se canceló) o si ya estaba resuelto.
pub fn decide(id: &str, allow: bool, reason: Option<String>) -> bool {
    decide_with(id, Verdict { allow, reason, by: DecidedBy::User })
}

/// Descarta lo que esté esperando de una tarea.
///
/// Se llama al cancelarla y al terminar su proceso. Un pedido sin dueño no lo va a
/// contestar nadie nunca, y dejarlo en la cola lo mostraría en la consola para siempre.
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
/// Primero miran las reglas de la carpeta; solo lo que ninguna cubre sube a la consola. Sin
/// eso, cinco agentes llenan la pantalla de preguntas y el usuario termina apretando "sí" a
/// todo — que es peor que no haber preguntado.
pub fn resolve(
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> Verdict {
    let rules = rules_for_task(db, task_id);

    match rules::decide(&rules, tool_name, &input) {
        Decision::Allow => {
            record(db, &Uuid::new_v4().to_string(), task_id, tool_name, &input, Some(true), DecidedBy::Rule);
            Verdict { allow: true, reason: None, by: DecidedBy::Rule }
        }
        Decision::Deny => {
            record(db, &Uuid::new_v4().to_string(), task_id, tool_name, &input, Some(false), DecidedBy::Rule);
            Verdict { allow: false, reason: Some(RULE_DENIED.into()), by: DecidedBy::Rule }
        }
        Decision::Ask => {
            let id = Uuid::new_v4().to_string();
            record(db, &id, task_id, tool_name, &input, None, DecidedBy::User);
            let verdict = ask(&id, task_id, tool_name, input, timeout);
            close_row(db, &id, &verdict);
            verdict
        }
    }
}

/// Resuelve con las reglas de la carpeta los pedidos que siguen esperando en ella.
///
/// Se llama después de guardar una regla. Sin esto, "permitir siempre `cargo test`" en un
/// agente dejaría esperando a otro agente de la misma carpeta que pidió exactamente lo
/// mismo un segundo antes — y el usuario tendría que contestarle a mano algo que acaba de
/// decir que no quiere contestar más.
pub fn release_matching(db: &DbConnection, cwd: &str) -> usize {
    let candidates = pending();
    if candidates.is_empty() {
        return 0;
    }

    let (rules, owned): (Vec<PermissionRule>, Vec<PendingApproval>) = {
        let Ok(conn) = db.lock() else { return 0 };
        let rules = store::list_rules(&conn, cwd)
            .unwrap_or_default()
            .into_iter()
            .map(|r| PermissionRule { pattern: r.pattern, allow: r.allow })
            .collect();
        let owned = candidates
            .into_iter()
            .filter(|p| store::project_cwd_of_task(&conn, &p.task_id).as_deref() == Some(cwd))
            .collect();
        (rules, owned)
    };

    owned
        .into_iter()
        .filter(|p| match rules::decide(&rules, &p.tool_name, &p.input) {
            Decision::Allow => decide_with(&p.id, Verdict { allow: true, reason: None, by: DecidedBy::Rule }),
            Decision::Deny => decide_with(
                &p.id,
                Verdict { allow: false, reason: Some(RULE_DENIED.into()), by: DecidedBy::Rule },
            ),
            Decision::Ask => false,
        })
        .count()
}

fn rules_for_task(db: &DbConnection, task_id: &str) -> Vec<PermissionRule> {
    let Ok(conn) = db.lock() else { return Vec::new() };
    let Some(cwd) = store::project_cwd_of_task(&conn, task_id) else { return Vec::new() };
    store::list_rules(&conn, &cwd)
        .unwrap_or_default()
        .into_iter()
        .map(|r| PermissionRule { pattern: r.pattern, allow: r.allow })
        .collect()
}

/// Deja el pedido anotado. `allowed = None` = queda pendiente.
///
/// Best-effort: no poder anotar un pedido no puede frenar la respuesta al agente. El
/// registro es para mirar después; la decisión es lo que el agente necesita ahora.
fn record(
    db: &DbConnection,
    id: &str,
    task_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
    allowed: Option<bool>,
    by: DecidedBy,
) {
    let now = now_ts();
    let (status, decided_by, decided_at) = match allowed {
        Some(true) => ("allowed", Some(by.as_str()), Some(now)),
        Some(false) => ("denied", Some(by.as_str()), Some(now)),
        None => ("pending", None, None),
    };
    let Ok(conn) = db.lock() else { return };
    let _ = conn.execute(
        "INSERT INTO task_approvals (id, task_id, tool_name, input_json, status, decided_by,
                                     asked_at, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, task_id, tool_name, input.to_string(), status, decided_by, now, decided_at],
    );
}

fn close_row(db: &DbConnection, id: &str, verdict: &Verdict) {
    let Ok(conn) = db.lock() else { return };
    let _ = conn.execute(
        "UPDATE task_approvals SET status = ?1, decided_by = ?2, reason = ?3, decided_at = ?4
         WHERE id = ?5",
        rusqlite::params![
            if verdict.allow { "allowed" } else { "denied" },
            verdict.by.as_str(),
            verdict.reason,
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
        "UPDATE task_approvals SET status = 'denied', decided_by = 'cancelled',
                                   reason = ?1, decided_at = ?2
         WHERE status = 'pending'",
        rusqlite::params!["la app se cerró antes de que se decidiera", now_ts()],
    )
    .map_err(|e| e.to_string())
}
