//! Workspaces cerrados a mano: lo que hace falta para volver a abrirlos como estaban.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

/// Una tab tal como estaba al cerrar el workspace.
///
/// Lleva `session_id` y `skill_ids` a propósito: sin la sesión, reabrir da una
/// conversación en blanco en vez de la que estabas teniendo; sin las skills, el agente
/// arranca sin lo que le habías puesto. Las dos cosas se pierden al cerrar la tab —
/// `project_skills.tab_id` cascadea con la fila de `tabs`—, así que hay que guardarlas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTab {
    pub title: String,
    pub title_is_custom: Option<bool>,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub session_id: Option<String>,
    pub account_id: Option<String>,
    #[serde(default)]
    pub prelaunch: serde_json::Value,
    #[serde(default)]
    pub skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub cwd: String,
    pub workspace_id: String,
    pub tabs: Vec<SnapshotTab>,
    pub closed_at: i64,
}

/// Guarda (o reemplaza) el recuerdo de una carpeta.
#[tauri::command]
pub fn save_workspace_snapshot(
    cwd: String,
    workspace_id: String,
    tabs: Vec<SnapshotTab>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let tabs_json = serde_json::to_string(&tabs).map_err(|e| e.to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO workspace_snapshots (cwd, workspace_id, tabs_json, closed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cwd) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             tabs_json    = excluded.tabs_json,
             closed_at    = excluded.closed_at",
        rusqlite::params![cwd, workspace_id, tabs_json, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_workspace_snapshots(db: tauri::State<DbConnection>) -> Result<Vec<WorkspaceSnapshot>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT cwd, workspace_id, tabs_json, closed_at FROM workspace_snapshots ORDER BY closed_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    Ok(rows
        .filter_map(|r| r.ok())
        .map(|(cwd, workspace_id, tabs_json, closed_at)| WorkspaceSnapshot {
            cwd,
            workspace_id,
            // Un JSON ilegible (de una versión vieja del formato) no puede hacer
            // desaparecer al resto de los workspaces cerrados: esa fila queda sin tabs y
            // el panel la muestra igual, para poder borrarla.
            tabs: serde_json::from_str(&tabs_json).unwrap_or_default(),
            closed_at,
        })
        .collect())
}

/// Lo devuelve y lo borra: reabrir un workspace consume su recuerdo.
#[tauri::command]
pub fn take_workspace_snapshot(
    cwd: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT workspace_id, tabs_json, closed_at FROM workspace_snapshots WHERE cwd = ?1",
            [&cwd],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((workspace_id, tabs_json, closed_at)) = row else { return Ok(None) };
    conn.execute("DELETE FROM workspace_snapshots WHERE cwd = ?1", [&cwd])
        .map_err(|e| e.to_string())?;

    Ok(Some(WorkspaceSnapshot {
        cwd,
        workspace_id,
        tabs: serde_json::from_str(&tabs_json).unwrap_or_default(),
        closed_at,
    }))
}

/// Olvidar un workspace cerrado sin reabrirlo.
#[tauri::command]
pub fn forget_workspace_snapshot(cwd: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM workspace_snapshots WHERE cwd = ?1", [&cwd])
        .map_err(|e| e.to_string())?;
    Ok(())
}
