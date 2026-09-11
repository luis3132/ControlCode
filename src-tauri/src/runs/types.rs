//! Los tipos que cruzan el módulo: la tarea, su estado, y el evento común.

use serde::{Deserialize, Serialize};

/// Un lote de trabajo. Por ahora agrupa tareas lanzadas a mano desde la consola; cuando
/// entre el DAG será también lo que declara un agente lead.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub workspace_id: String,
    pub objective: String,
    pub cwd: String,
    pub status: String,
    pub max_parallel: i64,
    pub budget_usd: Option<f64>,
    pub spent_usd: f64,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}

/// Una tarjeta de la consola: un agente headless con su trabajo.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub prompt: String,
    pub agent_id: String,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub cwd: String,
    pub budget_usd: Option<f64>,
    pub status: String,
    pub session_id: Option<String>,
    pub attempt: i64,
    pub result: Option<String>,
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub events_path: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

/// Los estados por los que pasa una tarea. Son strings en SQLite (como `scope` en
/// `project_skills`) y se escriben desde acá para que no haya dos grafías del mismo estado.
pub mod status {
    pub const READY: &str = "ready";
    pub const RUNNING: &str = "running";
    pub const DONE: &str = "done";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}

/// Lo que pasó en una tarea, ya traducido del dialecto de su TUI.
///
/// Es deliberadamente más pobre que el evento original: la consola muestra qué está
/// haciendo el agente, no su transcripción. El crudo queda en el `.jsonl` para quien lo
/// necesite; esto es lo que viaja a la UI en vivo.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// La TUI arrancó y dijo con qué sesión quedó. Es el id que después permite reabrir
    /// la tarea como tab con `--resume`.
    Started { session_id: Option<String> },
    /// Algo que el agente dijo.
    Text { text: String },
    /// Empezó a usar una herramienta. `label` ya viene en la forma corta que se muestra
    /// (`Bash(cargo test)`), armada por `activity::tool_label`.
    Tool { name: String, label: String },
    /// Cerró. Trae el veredicto y lo que costó.
    Finished { outcome: TaskOutcome },
}

/// El veredicto de una tarea.
///
/// Sale del evento de cierre de la TUI, y si nunca llegó, del código de salida. Ese orden
/// importa: un agente puede colgarse, quedarse sin presupuesto o morir a mitad, y en
/// ninguno de esos casos llega a decir nada. **El fin de una tarea lo decide el proceso,
/// no un mensaje del agente.**
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutcome {
    pub ok: bool,
    pub result: Option<String>,
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
}

impl TaskOutcome {
    pub fn failed(message: impl Into<String>) -> Self {
        TaskOutcome { ok: false, error: Some(message.into()), ..Default::default() }
    }
}
