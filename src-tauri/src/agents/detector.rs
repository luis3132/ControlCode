use serde::{Deserialize, Serialize};
use std::process::Command;

use super::registry::{self, AgentDef, SHELL_AGENT_ID};

/// Una TUI tal como la ve el frontend: lo que dice el registro más lo que solo se puede
/// saber sondeando esta máquina.
///
/// `resume` y `skills_dir` viajan aunque el backend no los necesite para responder: son
/// justamente los dos datos que el frontend tenía copiados en tablas propias
/// (`agentResume.ts`), y mandarlos acá es lo que le permite dejar de tenerlas.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub version: Option<String>,
    /// Argumentos de reanudación con el placeholder `{session}`. `None` = no sabe.
    pub resume: Option<String>,
    /// Carpeta de skills relativa al cwd. `None` = no gestiona skills.
    pub skills_dir: Option<String>,
}

/// ¿Está este comando en el PATH?
///
/// `which` no existe en Windows — ahí el equivalente es `where`. Con `which` a secas, en
/// Windows fallaba el spawn y TODAS las TUIs se reportaban como no instaladas.
pub fn command_exists(command: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    Command::new(probe)
        .arg(command)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn probe_agent(def: &AgentDef) -> AgentInfo {
    // `bash` es la salida de emergencia a una terminal pelada, no una TUI que se instale:
    // se reporta disponible sin sondear. En Windows el binario ni siquiera está en el
    // PATH con ese nombre, así que sondearlo lo daría por ausente.
    let is_shell = def.id == SHELL_AGENT_ID;
    let in_path = is_shell || command_exists(def.command);

    let version = if in_path && !is_shell {
        Command::new(def.command)
            .arg(def.version_flag)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.lines().next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    AgentInfo {
        id: def.id.to_string(),
        label: def.label.to_string(),
        command: def.command.to_string(),
        available: in_path,
        version,
        resume: def.resume.map(str::to_string),
        skills_dir: def.skills_dir.map(str::to_string),
    }
}

/// Detecta qué agentes de IA están instalados en el PATH del sistema.
/// Siempre incluye bash como último elemento con available: true.
///
/// `probe_agent` hace hasta 2 spawns de proceso bloqueantes por candidato (`which` +
/// `--version`) — sin `spawn_blocking`, ese trabajo síncrono corre directo sobre un
/// worker thread del executor async de Tauri (esta función es `async fn` pero no tiene
/// ningún `.await` real), bloqueándolo mientras dura. Se llama una vez por cada ventana
/// nueva que monta `AppShell`, así que con varias ventanas abriéndose a la vez podía
/// demorar otros comandos async programados en ese mismo worker.
#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> {
    tokio::task::spawn_blocking(|| registry::AGENTS.iter().map(probe_agent).collect())
        .await
        .map_err(|e| e.to_string())
}
