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


/// Detecta si el schema de `workspaces`/`windows`/`tabs` es el de una versión anterior
/// a esta fase: workspaces todavía indexado por `root_path` (modelo viejo de "carpeta raíz")
/// en vez de `name` (modelo de "layout guardado de ventanas/tabs").
fn needs_schema_v3(conn: &Connection) -> bool {
    conn.prepare("SELECT root_path FROM workspaces LIMIT 1").is_ok()
        || conn.prepare("SELECT workspace_id FROM tabs LIMIT 1").is_ok()
}

pub fn init_db() -> SqlResult<DbConnection> {
    let conn = Connection::open(db_path())?;

    // Pre-MVP: no hay datos reales que preservar, así que en vez de migrar
    // incrementalmente se recrean las tablas si el schema está desactualizado.
    if needs_schema_v3(&conn) {
        conn.execute_batch(
            "DROP TABLE IF EXISTS tabs; DROP TABLE IF EXISTS windows; DROP TABLE IF EXISTS workspaces;",
        )?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces (
             id          TEXT PRIMARY KEY,
             name        TEXT NOT NULL UNIQUE,
             created_at  INTEGER NOT NULL,
             last_active INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS windows (
             id           TEXT PRIMARY KEY,
             label        TEXT NOT NULL UNIQUE,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

    ensure_default_workspace(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}

/// Toda ventana debe pertenecer a un workspace. Si la app arranca sin ningún
/// workspace guardado todavía, se crea uno por defecto ("Sin guardar") al que
/// pertenecen las ventanas hasta que el usuario las guarde con un nombre propio.
fn ensure_default_workspace(conn: &Connection) -> SqlResult<()> {
    let has_any: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    if has_any == 0 {
        let now = now_ts();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![DEFAULT_WORKSPACE_ID, "Sin guardar", now],
        )?;
    }
    Ok(())
}

pub const DEFAULT_WORKSPACE_ID: &str = "default";

// ── Types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_active: i64,
}

/// Workspace + conteo de ventanas/tabs, para la lista de Home
/// (ej. "cliente — 2 ventanas (4+3 tabs)").
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub last_active: i64,
    pub window_count: i64,
    pub tab_count: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowRow {
    pub id: String,
    pub label: String,
    pub workspace_id: String,
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
    pub workspace_id: String,
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

fn row_to_window(row: &rusqlite::Row) -> rusqlite::Result<WindowRow> {
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
}

fn row_to_tab(row: &rusqlite::Row) -> rusqlite::Result<TabRow> {
    Ok(TabRow {
        id: row.get(0)?,
        window_id: row.get(1)?,
        title: row.get(2)?,
        title_is_custom: row.get::<_, i64>(3)? != 0,
        agent_id: row.get(4)?,
        agent_label: row.get(5)?,
        command: row.get(6)?,
        cwd: row.get(7)?,
        tab_order: row.get(8)?,
        session_id: row.get(9)?,
        scrollback: row.get(10)?,
        created_at: row.get(11)?,
        last_active: row.get(12)?,
    })
}

// ── Commands: workspaces ─────────────────────────────────────────
// Un workspace es una configuración nombrada y persistida de ventanas + sus tabs
// (no una carpeta raíz). Se crea explícitamente con "Guardar como workspace...".

/// Marca un workspace como usado ahora. Se llama en cada autosave de ventana y al
/// abrir un workspace explícitamente, para que el arranque de la app sepa cuál fue
/// el último workspace activo (no necesariamente "default").
pub fn touch_workspace_now(db: &DbConnection, workspace_id: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE workspaces SET last_active = ?1 WHERE id = ?2",
        rusqlite::params![now_ts(), workspace_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Id del workspace usado más recientemente (por `last_active`) — el que se restaura
/// automáticamente al arrancar la app. Siempre devuelve algo: `default` existe siempre.
pub fn db_get_last_active_workspace_id(db: &DbConnection) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id FROM workspaces ORDER BY last_active DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Si `default` tiene algún tab abierto sin guardar, "Nuevo workspace" (que lo resetea)
/// debe advertir antes de descartarlo. Cuenta tabs de ventanas `is_open=1` bajo `default`.
#[tauri::command]
pub fn default_workspace_has_content(db: tauri::State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tabs t JOIN windows w ON w.id = t.window_id
             WHERE w.workspace_id = ?1 AND w.is_open = 1",
            [DEFAULT_WORKSPACE_ID],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

#[tauri::command]
pub fn db_get_workspace(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Workspace, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, name, created_at, last_active FROM workspaces WHERE id = ?1",
        [&workspace_id],
        |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                last_active: row.get(3)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_list_workspaces(db: tauri::State<DbConnection>) -> Result<Vec<WorkspaceSummary>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            // Sin filtro de is_open: esto es "lo guardado", no "lo abierto ahora mismo" —
            // un workspace cerrado (todas sus ventanas con is_open=0) sigue teniendo sus
            // tabs/cwd/scrollback persistidos, y debe seguir mostrando esos conteos.
            "SELECT w.id, w.name, w.last_active,
                    COUNT(DISTINCT win.id) AS window_count,
                    COUNT(t.id) AS tab_count
             FROM workspaces w
             LEFT JOIN windows win ON win.workspace_id = w.id
             LEFT JOIN tabs t ON t.window_id = win.id
             WHERE w.id != ?1
             GROUP BY w.id
             ORDER BY w.last_active DESC",
        )
        .map_err(|e| e.to_string())?;

    let workspaces = stmt
        .query_map([DEFAULT_WORKSPACE_ID], |row| {
            Ok(WorkspaceSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                last_active: row.get(2)?,
                window_count: row.get(3)?,
                tab_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(workspaces)
}

/// Borra (en cascada, vía FK) todas las ventanas/tabs guardadas de un workspace, sin
/// tocar el registro del workspace en sí. Usado para "resetear" el bucket `default`:
/// como nunca se guarda con nombre, "Nuevo workspace" simplemente lo vacía por completo
/// en vez de crear un id nuevo — si el usuario quiere conservarlo, usa "Guardar workspace".
pub fn delete_workspace_windows(db: &DbConnection, workspace_id: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM windows WHERE workspace_id = ?1", [workspace_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Crea un workspace nuevo con `name`, y le transfiere todas las ventanas abiertas
/// que comparten el `source_workspace_id` (el workspace actual de la ventana desde la
/// que se guarda) — no todas las ventanas que estén abiertas en el proceso. Así, una
/// ventana "scratch" abierta vía "Nuevo workspace" (que vive en el bucket por defecto,
/// oculto) no se cuela al guardar el workspace con el que sí estás trabajando.
#[tauri::command]
pub fn db_save_workspace(
    name: String,
    source_workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Workspace, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();
    let id = Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![id, name, now],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE windows SET workspace_id = ?1, last_active = ?2 WHERE workspace_id = ?3 AND is_open = 1",
        rusqlite::params![id, now, source_workspace_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(Workspace { id, name, created_at: now, last_active: now })
}

#[tauri::command]
pub fn db_get_workspace_windows(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<WindowRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active
             FROM windows WHERE workspace_id = ?1 AND is_open = 1",
        )
        .map_err(|e| e.to_string())?;

    let windows = stmt
        .query_map([&workspace_id], row_to_window)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(windows)
}

/// Todas las ventanas guardadas de un workspace, sin importar `is_open` — a diferencia de
/// `db_get_workspace_windows` (que filtra `is_open = 1` y sirve para saber qué está VIVO
/// ahora mismo, ej. contar ventanas para el diálogo de cierre), esta es la que se usa para
/// RESTAURAR: un workspace guardado y cerrado tiene, por definición, todas sus filas en
/// `is_open = 0` — filtrar por eso ahí devolvía siempre cero filas y "abrir workspace"
/// no recreaba ninguna ventana.
pub fn db_get_all_workspace_windows(
    workspace_id: &str,
    db: &DbConnection,
) -> Result<Vec<WindowRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active
             FROM windows WHERE workspace_id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let windows = stmt
        .query_map([workspace_id], row_to_window)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(windows)
}

/// Marca una ventana como abierta (is_open = 1). El autosave normal (`db_save_window_state`)
/// nunca toca `is_open` en su `ON CONFLICT` — así que al recrear una ventana nativa a partir
/// de una fila que estaba guardada como cerrada (el caso típico al restaurar: se cerró, por
/// eso quedó guardada), hay que marcarla abierta explícitamente o los conteos de "ventanas
/// vivas" (confirmación de cierre, borrar workspace, etc.) seguirían viéndola como cerrada.
pub fn mark_window_open(db: &DbConnection, window_id: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE windows SET is_open = 1 WHERE id = ?1", [window_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marca como cerradas (is_open = 0) todas las ventanas de un workspace.
/// Usado cuando el usuario elige "cerrar las actuales" al cambiar de workspace.
#[tauri::command]
pub fn db_close_workspace_windows(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE windows SET is_open = 0 WHERE workspace_id = ?1",
        [&workspace_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_rename_workspace(
    workspace_id: String,
    name: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let affected = conn
        .execute(
            "UPDATE workspaces SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, workspace_id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("Workspace no encontrado".to_string());
    }
    Ok(())
}

/// Elimina un workspace guardado (sus ventanas/tabs se borran en cascada vía FK).
/// Rechaza borrar el workspace por defecto o uno que todavía tiene ventanas abiertas
/// (evita que el autosave de esas ventanas quede apuntando a un workspace_id inexistente).
#[tauri::command]
pub fn db_delete_workspace(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    if workspace_id == DEFAULT_WORKSPACE_ID {
        return Err("No se puede eliminar el workspace por defecto".to_string());
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    let open_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM windows WHERE workspace_id = ?1 AND is_open = 1",
            [&workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if open_count > 0 {
        return Err("Cierra las ventanas de este workspace antes de eliminarlo".to_string());
    }

    conn.execute("DELETE FROM workspaces WHERE id = ?1", [&workspace_id])
        .map_err(|e| e.to_string())?;
    Ok(())
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

    // El autosave de una ventana es justamente "uso" de su workspace: bumpear
    // last_active acá es lo que hace que el arranque siguiente reabra el workspace
    // correcto en vez de uno desactualizado.
    conn.execute(
        "UPDATE workspaces SET last_active = ?1 WHERE id = ?2",
        rusqlite::params![now, state.workspace_id],
    )
    .map_err(|e| e.to_string())?;

    let window_id: String = conn
        .query_row("SELECT id FROM windows WHERE label = ?1", [&state.label], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM tabs WHERE window_id = ?1", [&window_id])
        .map_err(|e| e.to_string())?;

    for t in &state.tabs {
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            rusqlite::params![
                t.id,
                window_id,
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
            row_to_window,
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(window) = window else { return Ok(None) };

    let mut stmt = conn
        .prepare(
            "SELECT id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, created_at, last_active
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
        .query_map([], row_to_window)
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

/// Renombra el label de una ventana ya guardada. Usado al abrir un workspace en caliente
/// (`open_workspace`) cuando el label original (típicamente "main") ya está ocupado por
/// la ventana nativa actual — el label es único a nivel de proceso, así que hay que
/// reasignarle uno libre antes de crear la ventana nueva, y el frontend de esa ventana
/// nueva carga su estado justamente buscando por su propio label nativo.
pub fn rename_window_label(db: &DbConnection, window_id: &str, new_label: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE windows SET label = ?1 WHERE id = ?2",
        rusqlite::params![new_label, window_id],
    )
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
