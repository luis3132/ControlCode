use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub version: Option<String>,
}

struct AgentCandidate {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    version_flag: &'static str,
}

const AGENTS: &[AgentCandidate] = &[
    AgentCandidate { id: "claude-code", label: "Claude Code", command: "claude",  version_flag: "--version" },
    AgentCandidate { id: "gemini-cli",  label: "Gemini CLI",  command: "gemini",  version_flag: "--version" },
    AgentCandidate { id: "codex",       label: "Codex",       command: "codex",   version_flag: "--version" },
];

fn probe_agent(candidate: &AgentCandidate) -> AgentInfo {
    let in_path = Command::new("which")
        .arg(candidate.command)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let version = if in_path {
        Command::new(candidate.command)
            .arg(candidate.version_flag)
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
        id: candidate.id.to_string(),
        label: candidate.label.to_string(),
        command: candidate.command.to_string(),
        available: in_path,
        version,
    }
}

/// Detecta qué agentes de IA están instalados en el PATH del sistema.
/// Siempre incluye bash como último elemento con available: true.
#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> {
    let mut agents: Vec<AgentInfo> = AGENTS.iter().map(probe_agent).collect();
    agents.push(AgentInfo {
        id: "bash".to_string(),
        label: "Terminal (bash)".to_string(),
        command: "bash".to_string(),
        available: true,
        version: None,
    });
    Ok(agents)
}
