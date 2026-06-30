use rusqlite::{Connection, OptionalExtension, Result as SqlResult};
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

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}


/// Detecta si el schema de `windows`/`tabs` es el de una versión anterior a esta fase
/// (sin la columna `label` en windows, o sin `scrollback` en tabs).
fn needs_schema_v2(conn: &Connection) -> bool {
    conn.prepare("SELECT label FROM windows LIMIT 1").is_err()
        || conn.prepare("SELECT scrollback FROM tabs LIMIT 1").is_err()
}

pub fn init_db() -> SqlResult<DbConnection> {
    let conn = Connection::open(db_path())?;

    // Pre-MVP: no hay datos reales que preservar, así que en vez de migrar
    // incrementalmente se recrean las tablas si el schema está desactualizado.
    if needs_schema_v2(&conn) {
        conn.execute_batch("DROP TABLE IF EXISTS tabs; DROP TABLE IF EXISTS windows;")?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces (
             id          TEXT PRIMARY KEY,
             name        TEXT NOT NULL,
             root_path   TEXT NOT NULL UNIQUE,
             created_at  INTEGER NOT NULL,
             last_active INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS windows (
             id           TEXT PRIMARY KEY,
             label        TEXT NOT NULL UNIQUE,
             workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
             pos_x        INTEGER,
             pos_y        INTEGER,
             width        INTEGER,
             height       INTEGER,
             monitor      TEXT,
             is_open      INTEGER NOT NULL DEFAULT 1,
             last_active  INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS tabs (
             id              TEXT PRIMARY KEY,
             window_id       TEXT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
             workspace_id    TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
             title           TEXT,
             title_is_custom INTEGER NOT NULL DEFAULT 0,
             agent_id        TEXT NOT NULL,
             agent_label     TEXT NOT NULL,
             command         TEXT NOT NULL,
             cwd             TEXT NOT NULL,
             tab_order       INTEGER NOT NULL DEFAULT 0,
             session_id      TEXT,
             scrollback      TEXT,
             created_at      INTEGER NOT NULL,
             last_active     INTEGER NOT NULL
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
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: i64,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowRow {
    pub id: String,
    pub label: String,
    pub workspace_id: Option<String>,
    pub pos_x: Option<i32>,
    pub pos_y: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub monitor: Option<String>,
    pub is_open: bool,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabRow {
    pub id: String,
    pub window_id: String,
    pub workspace_id: Option<String>,
    pub title: Option<String>,
    pub title_is_custom: bool,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub tab_order: i32,
    pub session_id: Option<String>,
    pub scrollback: Option<String>,
    pub created_at: i64,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabStatePayload {
    pub id: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub title_is_custom: bool,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub tab_order: i32,
    pub session_id: Option<String>,
    pub scrollback: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePayload {
    pub label: String,
    pub workspace_id: Option<String>,
    pub pos_x: Option<i32>,
    pub pos_y: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub monitor: Option<String>,
    pub tabs: Vec<TabStatePayload>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RestoredWindowState {
    pub window: WindowRow,
    pub tabs: Vec<TabRow>,
}

fn row_to_tab(row: &rusqlite::Row) -> rusqlite::Result<TabRow> {
    Ok(TabRow {
        id: row.get(0)?,
        window_id: row.get(1)?,
        workspace_id: row.get(2)?,
        title: row.get(3)?,
        title_is_custom: row.get::<_, i64>(4)? != 0,
        agent_id: row.get(5)?,
        agent_label: row.get(6)?,
        command: row.get(7)?,
        cwd: row.get(8)?,
        tab_order: row.get(9)?,
        session_id: row.get(10)?,
        scrollback: row.get(11)?,
        created_at: row.get(12)?,
        last_active: row.get(13)?,
    })
}

// ── Commands: workspaces ─────────────────────────────────────────

#[tauri::command]
pub fn db_get_workspaces(db: tauri::State<DbConnection>) -> Result<Vec<Workspace>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root_path, created_at, last_active FROM workspaces ORDER BY last_active DESC")
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
    let now = now_ts();

    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, created_at, last_active)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, name, root_path, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn db_touch_workspace(
    root_path: String,
    name: String,
    db: tauri::State<DbConnection>,
) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();

    conn.execute(
        "INSERT INTO workspaces (id, name, root_path, created_at, last_active)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(root_path) DO UPDATE SET last_active = excluded.last_active",
        rusqlite::params![Uuid::new_v4().to_string(), name, root_path, now],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id FROM workspaces WHERE root_path = ?1",
        [&root_path],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_recent_workspaces(
    limit: u32,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Workspace>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root_path, created_at, last_active FROM workspaces ORDER BY last_active DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;

    let workspaces = stmt
        .query_map([limit], |row| {
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

// ── Commands: windows + tabs (estado de sesión) ──────────────────

#[tauri::command]
pub fn db_save_window_state(
    state: WindowStatePayload,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();

    conn.execute(
        "INSERT INTO windows (id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
         ON CONFLICT(label) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           pos_x = excluded.pos_x, pos_y = excluded.pos_y,
           width = excluded.width, height = excluded.height,
           monitor = excluded.monitor,
           last_active = excluded.last_active",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            state.label,
            state.workspace_id,
            state.pos_x,
            state.pos_y,
            state.width,
            state.height,
            state.monitor,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    let window_id: String = conn
        .query_row("SELECT id FROM windows WHERE label = ?1", [&state.label], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM tabs WHERE window_id = ?1", [&window_id])
        .map_err(|e| e.to_string())?;

    for t in &state.tabs {
        conn.execute(
            "INSERT INTO tabs (id, window_id, workspace_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            rusqlite::params![
                t.id,
                window_id,
                t.workspace_id,
                t.title,
                t.title_is_custom as i64,
                t.agent_id,
                t.agent_label,
                t.command,
                t.cwd,
                t.tab_order,
                t.session_id,
                t.scrollback,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn db_load_window_state(
    label: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<RestoredWindowState>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let window = conn
        .query_row(
            "SELECT id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active
             FROM windows WHERE label = ?1",
            [&label],
            |row| {
                Ok(WindowRow {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    workspace_id: row.get(2)?,
                    pos_x: row.get(3)?,
                    pos_y: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    monitor: row.get(7)?,
                    is_open: row.get::<_, i64>(8)? != 0,
                    last_active: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(window) = window else { return Ok(None) };

    let mut stmt = conn
        .prepare(
            "SELECT id, window_id, workspace_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, created_at, last_active
             FROM tabs WHERE window_id = ?1 ORDER BY tab_order ASC",
        )
        .map_err(|e| e.to_string())?;

    let tabs = stmt
        .query_map([&window.id], row_to_tab)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Some(RestoredWindowState { window, tabs }))
}

#[tauri::command]
pub fn db_get_open_window_labels(db: tauri::State<DbConnection>) -> Result<Vec<WindowRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active
             FROM windows WHERE is_open = 1",
        )
        .map_err(|e| e.to_string())?;

    let windows = stmt
        .query_map([], |row| {
            Ok(WindowRow {
                id: row.get(0)?,
                label: row.get(1)?,
                workspace_id: row.get(2)?,
                pos_x: row.get(3)?,
                pos_y: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                monitor: row.get(7)?,
                is_open: row.get::<_, i64>(8)? != 0,
                last_active: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(windows)
}

#[tauri::command]
pub fn db_mark_window_closed(label: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE windows SET is_open = 0 WHERE label = ?1", [&label])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cuántas tabs tiene guardadas una ventana. Se usa al restaurar para no recrear
/// ventanas tear-off que se quedaron sin tabs (el usuario las cerró todas sin cerrar la ventana).
pub fn count_tabs_for_window(db: &DbConnection, window_id: &str) -> Result<i64, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM tabs WHERE window_id = ?1", [window_id], |row| row.get(0))
        .map_err(|e| e.to_string())
}
