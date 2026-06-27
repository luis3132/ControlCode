use rusqlite::{Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub type DbConnection = Arc<Mutex<Connection>>;

fn db_path() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let dir = home.join(".controlcode");
    std::fs::create_dir_all(&dir).expect("Cannot create ~/.controlcode");
    dir.join("data.db")
}

pub fn init_db() -> SqlResult<DbConnection> {
    let conn = Connection::open(db_path())?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;

         CREATE TABLE IF NOT EXISTS workspaces (
             id          TEXT PRIMARY KEY,
             name        TEXT NOT NULL,
             root_path   TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             last_active INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS windows (
             id           TEXT PRIMARY KEY,
             workspace_id TEXT REFERENCES workspaces(id),
             pos_x        INTEGER,
             pos_y        INTEGER,
             width        INTEGER,
             height       INTEGER,
             monitor      TEXT
         );

         CREATE TABLE IF NOT EXISTS tabs (
             id           TEXT PRIMARY KEY,
             window_id    TEXT NOT NULL REFERENCES windows(id),
             workspace_id TEXT REFERENCES workspaces(id),
             title        TEXT,
             agent        TEXT NOT NULL,
             cwd          TEXT NOT NULL,
             tab_order    INTEGER NOT NULL DEFAULT 0,
             session_id   TEXT,
             created_at   INTEGER NOT NULL,
             last_active  INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS skills (
             id           TEXT PRIMARY KEY,
             name         TEXT NOT NULL,
             description  TEXT,
             file_path    TEXT NOT NULL,
             installed_at INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS project_skills (
             skill_id     TEXT NOT NULL REFERENCES skills(id),
             workspace_id TEXT NOT NULL REFERENCES workspaces(id),
             scope        TEXT NOT NULL DEFAULT 'workspace',
             tab_id       TEXT REFERENCES tabs(id),
             PRIMARY KEY (skill_id, workspace_id, scope, tab_id)
         );",
    )?;

    Ok(Arc::new(Mutex::new(conn)))
}

// ── Types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: i64,
    pub last_active: i64,
}

// ── Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn db_get_workspaces(db: tauri::State<DbConnection>) -> Result<Vec<Workspace>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, root_path, created_at, last_active
             FROM workspaces
             ORDER BY last_active DESC",
        )
        .map_err(|e| e.to_string())?;

    let workspaces = stmt
        .query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                created_at: row.get(3)?,
                last_active: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(workspaces)
}

#[tauri::command]
pub fn db_create_workspace(
    name: String,
    root_path: String,
    db: tauri::State<DbConnection>,
) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, created_at, last_active)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, name, root_path, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}
