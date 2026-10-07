//! Los comandos de Tauri del modo HTML.

use tauri::{AppHandle, State};

use crate::database::DbConnection;

use super::parse::{self, ChatEvent};
use super::session::{self, ChatTurn};

/// Manda un mensaje: lanza el turno de la tab. Falla si ya tiene uno andando (el chat los
/// pone en cola y manda el siguiente cuando termina el anterior).
#[tauri::command]
pub fn chat_send(app: AppHandle, turn: ChatTurn) -> Result<(), String> {
    let name = crate::agents::agent_command("claude-code").unwrap_or("claude");
    // La ruta completa: en Windows un `claude.cmd` de npm no se ejecuta por su nombre.
    let program = crate::util::find_program(name).map(|p| p.into_os_string()).unwrap_or_else(|| name.into());
    let mcp = crate::ipc::mcp::chat_mcp(&app, &turn.cwd, &turn.tab_id);
    let args = session::claude_args(
        &turn,
        mcp.as_ref().map(|(path, allowed)| (path.to_str().unwrap_or_default(), allowed.as_slice())),
    );
    session::start(&app, turn, program, args)
}

/// Para el turno en curso. `false` si no había ninguno.
#[tauri::command]
pub fn chat_stop(tab_id: String) -> bool {
    session::stop(&tab_id)
}

#[tauri::command]
pub fn chat_running(tab_id: String) -> bool {
    session::is_running(&tab_id)
}

/// La conversación guardada de una sesión de Claude Code, con herramientas y resultados.
///
/// Por id exacto y nunca "la más reciente de la carpeta": mostrar otra conversación como si
/// fuera la de esta tab es peor que no mostrar ninguna. Vacío si todavía no existe (una
/// sesión nueva que no mandó nada).
#[tauri::command]
pub async fn chat_transcript(
    cwd: String,
    session_id: String,
    account_id: Option<String>,
    db: State<'_, DbConnection>,
) -> Result<Vec<ChatEvent>, String> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("'{session_id}' no es un id de sesión"));
    }
    let profile = account_id.as_deref().and_then(|id| crate::accounts::dir_for(&db, id));
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::session::claude_project_dir(&cwd, profile.as_deref().map(std::path::Path::new));
        match std::fs::read_to_string(dir.join(format!("{session_id}.jsonl"))) {
            Ok(content) => Ok(parse::transcript(&content)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
