//! Los comandos de Tauri del modo HTML.

use tauri::{AppHandle, State};

use crate::database::DbConnection;

use super::parse::{self, ChatEvent};
use super::session::{self, ChatTurn};

// Todos `async` y con lo que toca disco o procesos en `spawn_blocking`: un comando síncrono
// de Tauri corre en el hilo principal, y mientras dura no se mueve nada en la ventana.

/// Manda un mensaje: lanza el turno de la tab. Falla si ya tiene uno andando (el chat los
/// pone en cola y manda el siguiente cuando termina el anterior).
#[tauri::command]
pub async fn chat_send(app: AppHandle, turn: ChatTurn) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = crate::agents::agent_command("claude-code").unwrap_or("claude");
        // La ruta completa: en Windows un `claude.cmd` de npm no se ejecuta por su nombre.
        let program = crate::util::find_program(name).map(|p| p.into_os_string()).unwrap_or_else(|| name.into());
        // Sin puente de permisos para una pregunta al margen: no edita (corre en modo
        // plan), así que no tiene nada que preguntar, y una tarjeta de permiso de algo que la
        // persona no mandó sería un susto.
        let mcp = if turn.side { None } else { crate::ipc::mcp::chat_mcp(&app, &turn.cwd, &turn.tab_id) };
        let args = session::claude_args(
            &turn,
            mcp.as_ref().map(|(path, allowed)| (path.to_str().unwrap_or_default(), allowed.as_slice())),
        );
        session::start(&app, turn, program, args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Para el turno en curso. `false` si no había ninguno. Matar el árbol puede esperar (en
/// macOS se le da un momento para cerrar antes de forzarlo), así que no va en el hilo
/// principal.
#[tauri::command]
pub async fn chat_stop(tab_id: String, side: Option<bool>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || session::stop(&tab_id, side.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn chat_running(tab_id: String) -> bool {
    session::is_running(&tab_id)
}

/// Con qué arranca un turno cuando la tab no eligió nada: lo que tenga configurado la
/// propia TUI.
#[derive(serde::Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatDefaults {
    pub model: Option<String>,
    /// `low` … `max`, de `settings.json`.
    pub effort: Option<String>,
    /// El interruptor del panel `/effort` de la TUI. No hay flag para esto en `-p`: lo
    /// lee la CLI de su propia configuración, así que acá solo se informa que está puesto.
    pub ultracode: bool,
}

/// Mezcla las capas de configuración como las mezcla la CLI: lo del proyecto pisa lo del
/// usuario. Puro, para poder probarlo sin tocar el disco de nadie.
pub fn merge_defaults(layers: &[serde_json::Value]) -> ChatDefaults {
    let mut out = ChatDefaults::default();
    for layer in layers {
        if let Some(model) = layer.get("model").and_then(|m| m.as_str()) {
            out.model = Some(model.to_string());
        }
        if let Some(effort) = layer.get("effortLevel").and_then(|e| e.as_str()) {
            out.effort = Some(effort.to_string());
        }
        if let Some(ultra) = layer.get("ultracode").and_then(|u| u.as_bool()) {
            out.ultracode = ultra;
        }
    }
    out
}

/// Lo que la TUI usaría por su cuenta en esta carpeta y con esta cuenta.
#[tauri::command]
pub async fn chat_defaults(
    cwd: String,
    account_id: Option<String>,
    db: State<'_, DbConnection>,
) -> Result<ChatDefaults, String> {
    let profile = account_id.as_deref().and_then(|id| crate::accounts::dir_for(&db, id));
    tauri::async_runtime::spawn_blocking(move || {
        let user = profile
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
            .map(|dir| dir.join("settings.json"));
        let read = |path: Option<std::path::PathBuf>| -> Option<serde_json::Value> {
            serde_json::from_str(&std::fs::read_to_string(path?).ok()?).ok()
        };
        let project = std::path::Path::new(&cwd).join(".claude");
        let layers: Vec<serde_json::Value> = [
            read(user),
            read(Some(project.join("settings.json"))),
            read(Some(project.join("settings.local.json"))),
        ]
        .into_iter()
        .flatten()
        .collect();
        merge_defaults(&layers)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Con qué modelo y esfuerzo viene corriendo una sesión (ver `parse::session_settings`).
/// Vacío si todavía no existe.
#[tauri::command]
pub async fn chat_session_settings(
    cwd: String,
    session_id: String,
    account_id: Option<String>,
    db: State<'_, DbConnection>,
) -> Result<parse::SessionSettings, String> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("'{session_id}' no es un id de sesión"));
    }
    let profile = account_id.as_deref().and_then(|id| crate::accounts::dir_for(&db, id));
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::session::claude_project_dir(&cwd, profile.as_deref().map(std::path::Path::new));
        match std::fs::read_to_string(dir.join(format!("{session_id}.jsonl"))) {
            Ok(content) => parse::session_settings(&content),
            Err(_) => parse::SessionSettings::default(),
        }
    })
    .await
    .map_err(|e| e.to_string())
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
