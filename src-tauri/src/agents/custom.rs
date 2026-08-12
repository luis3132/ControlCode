//! TUIs personalizadas: las que el usuario agrega a mano, con su configuración de
//! integración con la app (reanudación de sesión, carpeta de skills, variables de
//! entorno, descubrimiento de sesiones).
//!
//! Las TUIs soportadas de fábrica tienen esa integración hardcodeada porque se verificó
//! contra la documentación real de cada CLI (ver `skills::links_dir_for`,
//! `agentResume.ts`, `session::title`). Para una TUI arbitraria no hay forma de
//! adivinarla, así que se la declara acá y el resto de la app la consulta por el mismo
//! camino que usa para las conocidas.
//!
//! Vive en SQLite y no en el frontend porque el backend la necesita sin que haya ninguna
//! ventana involucrada: la reconciliación de symlinks de skills corre al cerrar una
//! ventana y tiene que saber en qué carpeta guarda sus skills cada TUI.

use crate::database::DbConnection;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// De dónde sale el id de sesión del archivo que la TUI acaba de crear.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionIdSource {
    /// El nombre del archivo ES el id (caso Claude Code: `<uuid>.jsonl`).
    Filename,
    /// Hay que buscar esta clave dentro del JSON/JSONL (caso Codex: `session_id`).
    Field(String),
}

impl SessionIdSource {
    pub(super) fn parse(raw: &str) -> Self {
        match raw.split_once(':') {
            Some(("field", key)) if !key.trim().is_empty() => {
                SessionIdSource::Field(key.trim().to_string())
            }
            _ => SessionIdSource::Filename,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub label: String,
    /// Comando de invocación, tal cual se lanza en el PTY (puede traer flags: `mitui --foo`).
    pub command: String,
    /// Argumentos de reanudación con el placeholder `{session}`, ej. `--resume {session}`.
    /// Vacío = esta TUI no sabe reanudar y sus tabs siempre arrancan de cero.
    pub resume_args: Option<String>,
    /// Carpeta de skills relativa al cwd del proyecto, ej. `.agents/skills`.
    /// Vacío = la app no le gestiona skills.
    pub skills_dir: Option<String>,
    /// Carpeta donde la TUI guarda sus sesiones, ej. `~/.mitui/sessions`.
    pub sessions_dir: Option<String>,
    /// `filename` o `field:<clave>` — ver `SessionIdSource`.
    pub session_id_from: String,
    /// Variables de entorno extra al lanzar el proceso.
    pub env: HashMap<String, String>,
}

impl CustomAgent {
    pub fn session_id_source(&self) -> SessionIdSource {
        SessionIdSource::parse(&self.session_id_from)
    }

    /// Carpeta de sesiones con `~` expandido, o `None` si no se configuró.
    pub fn resolved_sessions_dir(&self) -> Option<std::path::PathBuf> {
        let raw = self.sessions_dir.as_deref()?.trim();
        if raw.is_empty() {
            return None;
        }
        let home = dirs::home_dir()?;
        let expanded = match raw.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None if raw == "~" => home,
            None => std::path::PathBuf::from(raw),
        };
        Some(expanded)
    }
}

/// Normaliza un campo opcional que viene del formulario: los strings vacíos se guardan
/// como NULL para que "no configurado" tenga una sola representación.
fn blank_to_none(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn row_to_custom_agent(row: &rusqlite::Row) -> rusqlite::Result<CustomAgent> {
    let env_json: String = row.get(7)?;
    Ok(CustomAgent {
        id: row.get(0)?,
        label: row.get(1)?,
        command: row.get(2)?,
        resume_args: row.get(3)?,
        skills_dir: row.get(4)?,
        sessions_dir: row.get(5)?,
        session_id_from: row.get(6)?,
        env: serde_json::from_str(&env_json).unwrap_or_default(),
    })
}

const COLUMNS: &str =
    "id, label, command, resume_args, skills_dir, sessions_dir, session_id_from, env_json";

/// Busca una TUI custom por id sobre una conexión ya lockeada — los llamadores internos
/// (skills, sesiones) suelen tener el lock tomado y no pueden volver a pedirlo.
pub fn find(conn: &rusqlite::Connection, id: &str) -> Option<CustomAgent> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM custom_agents WHERE id = ?1"),
        [id],
        row_to_custom_agent,
    )
    .optional()
    .ok()
    .flatten()
}

// ── Comandos ─────────────────────────────────────────────────────

#[tauri::command]
pub fn list_custom_agents(db: tauri::State<DbConnection>) -> Result<Vec<CustomAgent>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM custom_agents ORDER BY created_at ASC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_custom_agent)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Crea o actualiza una TUI custom. Sin `id` crea una nueva; con `id` de una existente,
/// la pisa entera (el formulario siempre manda el objeto completo).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn upsert_custom_agent(
    id: Option<String>,
    label: String,
    command: String,
    resume_args: Option<String>,
    skills_dir: Option<String>,
    sessions_dir: Option<String>,
    session_id_from: Option<String>,
    env: Option<HashMap<String, String>>,
    db: tauri::State<DbConnection>,
) -> Result<CustomAgent, String> {
    let label = label.trim().to_string();
    let command = command.trim().to_string();
    if label.is_empty() || command.is_empty() {
        return Err("El nombre y el comando son obligatorios".to_string());
    }

    let resume_args = blank_to_none(resume_args);
    if let Some(args) = &resume_args {
        if !args.contains("{session}") {
            return Err(
                "Los argumentos de reanudación deben incluir {session} (ej. --resume {session})"
                    .to_string(),
            );
        }
    }

    // Un path absoluto acá plantaría los symlinks fuera del proyecto, que es justo lo
    // contrario de lo que hace la carpeta de skills (es relativa al cwd de cada tab).
    let skills_dir = blank_to_none(skills_dir);
    if let Some(dir) = &skills_dir {
        if std::path::Path::new(dir).is_absolute() || dir.starts_with("~") {
            return Err(
                "La carpeta de skills es relativa al proyecto (ej. .agents/skills), no absoluta"
                    .to_string(),
            );
        }
    }

    let session_id_from = blank_to_none(session_id_from).unwrap_or_else(|| "filename".to_string());
    let env = env.unwrap_or_default();
    let env_json = serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string());
    let id = id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| Uuid::new_v4().to_string());

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO custom_agents (id, label, command, resume_args, skills_dir, sessions_dir, session_id_from, env_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           command = excluded.command,
           resume_args = excluded.resume_args,
           skills_dir = excluded.skills_dir,
           sessions_dir = excluded.sessions_dir,
           session_id_from = excluded.session_id_from,
           env_json = excluded.env_json",
        rusqlite::params![
            id,
            label,
            command,
            resume_args,
            skills_dir,
            blank_to_none(sessions_dir),
            session_id_from,
            env_json,
            now_ts()
        ],
    )
    .map_err(|e| e.to_string())?;

    find(&conn, &id).ok_or_else(|| "No se pudo releer la TUI recién guardada".to_string())
}

#[tauri::command]
pub fn delete_custom_agent(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM custom_agents WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Importa las TUIs que una versión anterior guardaba en `localStorage` del frontend.
/// Idempotente por id: reimportar no duplica ni pisa lo que el usuario ya editó acá.
#[tauri::command]
pub fn import_legacy_custom_agents(
    agents: Vec<LegacyCustomAgent>,
    db: tauri::State<DbConnection>,
) -> Result<usize, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut imported = 0;
    for a in agents {
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO custom_agents (id, label, command, session_id_from, env_json, created_at)
                 VALUES (?1, ?2, ?3, 'filename', '{}', ?4)",
                rusqlite::params![a.id, a.label, a.command, now_ts()],
            )
            .map_err(|e| e.to_string())?;
        imported += changed;
    }
    Ok(imported)
}

#[derive(Deserialize)]
pub struct LegacyCustomAgent {
    pub id: String,
    pub label: String,
    pub command: String,
}
