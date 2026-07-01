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

/// Detecta el scaffolding viejo (sin usar) de `skills`/`project_skills`, previo a la
/// Fase 5: `skills.file_path` en vez de `source_path`, o `project_skills` sin `id`
/// sintético. Ninguna de las dos tablas tuvo datos reales en producción todavía.
fn needs_schema_v4(conn: &Connection) -> bool {
    conn.prepare("SELECT source_path FROM skills LIMIT 1").is_err()
        || conn.prepare("SELECT id FROM project_skills LIMIT 1").is_err()
}

/// Detecta si a `tabs` le falta `opened_at` (fecha/hora en que el usuario abrió la tab
/// por primera vez — distinto de `created_at`, que se re-estampa en cada autosave porque
/// la fila se borra y reinserta completa).
fn needs_schema_v6(conn: &Connection) -> bool {
    conn.prepare("SELECT opened_at FROM tabs LIMIT 1").is_err()
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
    if needs_schema_v4(&conn) {
        conn.execute_batch(
            "DROP TABLE IF EXISTS project_skills; DROP TABLE IF EXISTS skills;",
        )?;
    }
    if needs_schema_v6(&conn) {
        conn.execute_batch(
            "DROP TABLE IF EXISTS project_skills; DROP TABLE IF EXISTS tabs;",
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
             opened_at       INTEGER NOT NULL,
             created_at      INTEGER NOT NULL,
             last_active     INTEGER NOT NULL
         );

         -- Copia global: una fila por skill instalada bajo el directorio configurado.
         -- `source_path` es la carpeta canónica que contiene SKILL.md; los proyectos
         -- nunca reciben una copia propia de los archivos, solo un symlink a este path.
         -- `categories`/`compatible_agents`/`compatible_versions` van como JSON (TEXT):
         -- son metadata de solo-lectura derivada del frontmatter, la DB es cache.
         CREATE TABLE IF NOT EXISTS skills (
             id                  TEXT PRIMARY KEY,
             name                TEXT NOT NULL,
             description         TEXT,
             version             TEXT NOT NULL DEFAULT '0.1.0',
             categories          TEXT NOT NULL DEFAULT '[]',
             compatible_agents   TEXT NOT NULL DEFAULT '[]',
             compatible_versions TEXT NOT NULL DEFAULT '{}',
             author              TEXT,
             license             TEXT,
             homepage            TEXT,
             source_path         TEXT NOT NULL UNIQUE,
             installed_at        INTEGER NOT NULL,
             updated_at          INTEGER NOT NULL
         );

         -- Intención de attach: \"esta skill debe estar activa en este workspace (todas
         -- sus tabs) o en esta tab puntual\". El symlink físico se deriva de esta fila
         -- en attach/detach y se re-verifica en el health check; no se persiste un
         -- link_path por-tab porque scope='workspace' puede implicar N tabs a la vez.
         CREATE TABLE IF NOT EXISTS project_skills (
             id           TEXT PRIMARY KEY,
             skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             scope        TEXT NOT NULL DEFAULT 'workspace',
             tab_id       TEXT REFERENCES tabs(id) ON DELETE CASCADE,
             enabled      INTEGER NOT NULL DEFAULT 1,
             created_at   INTEGER NOT NULL,
             UNIQUE (skill_id, workspace_id, scope, tab_id)
         );
         CREATE INDEX IF NOT EXISTS idx_project_skills_workspace ON project_skills(workspace_id);
         CREATE INDEX IF NOT EXISTS idx_project_skills_skill ON project_skills(skill_id);

         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );

         -- Historial de tabs cerradas ('Sesiones'). A propósito NO tiene FK hacia
         -- `windows`/`tabs` (esas se borran y reescriben constantemente, ver
         -- db_save_window_state) — solo hacia `workspaces(id) ON DELETE CASCADE`, que
         -- únicamente se borra si el workspace entero se elimina. Así sobrevive al reset
         -- del bucket `default` (que borra sus `windows`/`tabs` pero nunca la fila de
         -- `workspaces` en sí). `skills` se denormaliza como JSON (mismo patrón que
         -- `skills.categories`) porque `project_skills.tab_id` sí cascadea con `tabs` y
         -- se perdería en el mismo borrado que dispara este archivo.
         CREATE TABLE IF NOT EXISTS session_history (
             id           TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             agent_id     TEXT NOT NULL,
             agent_label  TEXT NOT NULL,
             command      TEXT NOT NULL,
             cwd          TEXT NOT NULL,
             title        TEXT,
             session_id   TEXT,
             skills       TEXT NOT NULL DEFAULT '[]',
             opened_at    INTEGER NOT NULL,
             closed_at    INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_session_history_workspace ON session_history(workspace_id);",
    )?;

    ensure_default_workspace(&conn)?;
    ensure_default_settings(&conn)?;

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

/// Siembra los valores por defecto de `settings` que el backend necesita leer de forma
/// autónoma (sin que el frontend se los pase en cada llamada), como el directorio global
/// de skills. Solo inserta si la key todavía no existe — no pisa un valor ya elegido.
fn ensure_default_settings(conn: &Connection) -> SqlResult<()> {
    let has_skills_dir: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = 'skills_dir'",
        [],
        |r| r.get(0),
    )?;
    if has_skills_dir == 0 {
        let home = dirs::home_dir().expect("Cannot determine home directory");
        let default_dir = home.join(".controlcode").join("skills");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
            [default_dir.to_string_lossy().to_string()],
        )?;
    }
    Ok(())
}

/// Lee una key de `settings`. No es un comando Tauri para poder llamarse desde otros
/// módulos backend (ej. `skills::resolve_skills_dir`) sin pasar por la capa de invoke.
pub fn get_setting(db: &DbConnection, key: &str) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

/// Escribe/actualiza una key de `settings`. Ver `get_setting` sobre por qué no es
/// directamente un `#[tauri::command]`.
pub fn set_setting(db: &DbConnection, key: &str, value: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn db_get_setting(key: String, db: tauri::State<DbConnection>) -> Result<Option<String>, String> {
    get_setting(&db, &key)
}

#[tauri::command]
pub fn db_set_setting(key: String, value: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    set_setting(&db, &key, &value)
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
    pub opened_at: i64,
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
    pub opened_at: i64,
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
        opened_at: row.get(11)?,
        created_at: row.get(12)?,
        last_active: row.get(13)?,
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

    // Antes de perder todo (cascada windows→tabs→project_skills.tab_id), archivar cada
    // tab en `session_history` — este es justamente el caso que le importa al usuario:
    // "Nuevo workspace" resetea `default` por completo, pero su historial de sesiones no.
    let mut tab_ids_stmt = conn
        .prepare(
            "SELECT t.id FROM tabs t JOIN windows w ON w.id = t.window_id WHERE w.workspace_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let tab_ids: Vec<String> = tab_ids_stmt
        .query_map([workspace_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(tab_ids_stmt);
    for tab_id in &tab_ids {
        archive_tab_row(&conn, tab_id, workspace_id)?;
    }

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

// ── Sesiones (historial de tabs cerradas) ─────────────────────────

/// Archiva el estado actual de una tab en `session_history` justo ANTES de que su fila
/// desaparezca de `tabs` (autosave que ya no la incluye, o borrado de su ventana). Si
/// `session_id` no es nulo y ya existe una entrada con ese mismo id (la misma
/// conversación real del agente, cerrada/reabierta varias veces), actualiza esa fila en
/// vez de duplicarla — el historial muestra "sesiones", no un log de cada cierre.
fn archive_tab_row(conn: &Connection, tab_id: &str, workspace_id: &str) -> Result<(), String> {
    let row: Option<(String, String, String, String, Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT agent_id, agent_label, command, cwd, title, session_id, opened_at FROM tabs WHERE id = ?1",
            [tab_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((agent_id, agent_label, command, cwd, title, session_id, opened_at)) = row else { return Ok(()) };

    // Skills activas para esta tab al momento de archivar: por-tab (scope='tab') o
    // por-workspace (scope='workspace'). Se "congelan" acá porque `project_skills.tab_id`
    // cascadea con `tabs` y desaparecería en el mismo borrado que dispara este archivo.
    let mut stmt = conn
        .prepare(
            "SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id
             WHERE ps.enabled = 1 AND (
               (ps.scope = 'tab' AND ps.tab_id = ?1) OR
               (ps.scope = 'workspace' AND ps.workspace_id = ?2)
             )",
        )
        .map_err(|e| e.to_string())?;
    let skill_names: Vec<String> = stmt
        .query_map(rusqlite::params![tab_id, workspace_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let skills_json = serde_json::to_string(&skill_names).unwrap_or_else(|_| "[]".to_string());
    let now = now_ts();

    if let Some(sid) = &session_id {
        let existing_id: Option<String> = conn
            .query_row("SELECT id FROM session_history WHERE session_id = ?1", [sid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(hid) = existing_id {
            // opened_at NO se toca: representa cuándo se abrió esa conversación por
            // primera vez, no la última vez que se retomó/cerró.
            conn.execute(
                "UPDATE session_history SET agent_id=?1, agent_label=?2, command=?3, cwd=?4, title=?5, skills=?6, closed_at=?7 WHERE id=?8",
                rusqlite::params![agent_id, agent_label, command, cwd, title, skills_json, now, hid],
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    conn.execute(
        "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            workspace_id,
            agent_id,
            agent_label,
            command,
            cwd,
            title,
            session_id,
            skills_json,
            opened_at,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub title: Option<String>,
    pub session_id: Option<String>,
    pub skills: Vec<String>,
    pub opened_at: i64,
    pub closed_at: i64,
}

/// Historial de tabs cerradas de un workspace, más reciente primero. Filtrado
/// estrictamente por `workspace_id` — dos workspaces nunca comparten entradas.
#[tauri::command]
pub fn db_list_session_history(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at
             FROM session_history WHERE workspace_id = ?1 ORDER BY closed_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([&workspace_id], |row| {
            let skills_json: String = row.get(8)?;
            let skills: Vec<String> = serde_json::from_str(&skills_json).unwrap_or_default();
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                agent_id: row.get(2)?,
                agent_label: row.get(3)?,
                command: row.get(4)?,
                cwd: row.get(5)?,
                title: row.get(6)?,
                session_id: row.get(7)?,
                skills,
                opened_at: row.get(9)?,
                closed_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabLocation {
    pub window_label: String,
    pub tab_id: String,
}

/// Busca si `session_id` ya está abierto en alguna tab viva (ventana `is_open = 1`) de
/// ESE workspace — usado por "Reabrir" en Sesiones: si la conversación ya está abierta en
/// algún lado, hay que enfocar esa tab en vez de abrir un duplicado.
#[tauri::command]
pub fn find_open_tab_for_session(
    session_id: String,
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<OpenTabLocation>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT w.label, t.id FROM tabs t
         JOIN windows w ON w.id = t.window_id
         WHERE t.session_id = ?1 AND w.workspace_id = ?2 AND w.is_open = 1
         LIMIT 1",
        rusqlite::params![session_id, workspace_id],
        |row| Ok(OpenTabLocation { window_label: row.get(0)?, tab_id: row.get(1)? }),
    )
    .optional()
    .map_err(|e| e.to_string())
}

// ── Commands: windows + tabs (estado de sesión) ──────────────────

#[tauri::command]
pub fn db_save_window_state(
    state: WindowStatePayload,
    db: tauri::State<DbConnection>,
    app: tauri::AppHandle,
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

    // Tabs que estaban guardadas en esta ventana y ya no vienen en el payload nuevo =
    // tabs que el usuario cerró — se archivan en `session_history` antes de perderlas
    // (ver comentario de `archive_tab_row`).
    let mut existing_ids_stmt = conn
        .prepare("SELECT id FROM tabs WHERE window_id = ?1")
        .map_err(|e| e.to_string())?;
    let existing_ids: Vec<String> = existing_ids_stmt
        .query_map([&window_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(existing_ids_stmt);
    let incoming_ids: std::collections::HashSet<&str> =
        state.tabs.iter().map(|t| t.id.as_str()).collect();
    for closed_id in existing_ids.iter().filter(|id| !incoming_ids.contains(id.as_str())) {
        archive_tab_row(&conn, closed_id, &state.workspace_id)?;
    }

    conn.execute("DELETE FROM tabs WHERE window_id = ?1", [&window_id])
        .map_err(|e| e.to_string())?;

    for t in &state.tabs {
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, opened_at, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
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
                t.opened_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // El conteo de tabs de este workspace pudo haber cambiado (tab agregada/cerrada) —
    // se notifica a todas las ventanas (ej. el Home de otra ventana) para que refresquen.
    use tauri::Emitter;
    let _ = app.emit("cc-workspace-changed", ());

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
            "SELECT id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, opened_at, created_at, last_active
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

/// Workspace al que pertenece una ventana nativa viva, buscando por su label. Usado antes
/// de aceptar un "merge" de tab entre ventanas (arrastrar una tab al tab bar de otra
/// ventana): si el workspace de destino no coincide con el de origen, el merge se rechaza
/// para no mezclar tabs de distintos workspaces por accidente.
#[tauri::command]
pub fn db_get_window_workspace(
    label: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT workspace_id FROM windows WHERE label = ?1",
        [&label],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
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

/// Marca una ventana como cerrada (is_open = 0) sin borrar su fila. Es el comportamiento
/// por defecto de CUALQUIER cierre nativo, incluidos los cierres EN BLOQUE (cerrar todo un
/// workspace, cambiar de workspace cerrando las anteriores, salida completa de la app) —
/// en esos casos se quiere preservar todo para la próxima restauración. El cierre de UNA
/// sola ventana mientras el resto del workspace sigue vivo pasa por
/// `forget_or_close_single_window` en cambio (ver más abajo), no por acá.
#[tauri::command]
pub fn db_mark_window_closed(label: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE windows SET is_open = 0 WHERE label = ?1", [&label])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Se usa cuando el usuario cierra explícitamente UNA sola ventana (no un cierre en
/// bloque, ver comentario de `db_mark_window_closed`). Si el workspace todavía tiene
/// otras ventanas vivas, esta fila se borra directamente (igual que pasa al cerrar una
/// tab) para que el conteo de ventanas y la próxima apertura del workspace reflejen la
/// baja de inmediato, en vez de resucitarla la próxima vez que se abra ese workspace. Si
/// era la última ventana viva del workspace, en cambio se preserva (`is_open = 0`) — ese
/// caso equivale a "cerrar" el workspace entero, que sí debe quedar restaurable.
///
/// Devuelve `Some(workspace_id)` cuando esta era la última ventana viva de su workspace
/// (el caso "preservado") — el llamador usa esto para decidir si hay que abrirle una
/// ventana en blanco de reemplazo (ver `create_blank_window_row`), y `None` si se borró
/// (todavía quedan otras ventanas del mismo workspace) o si el label no existía.
pub fn forget_or_close_single_window(db: &DbConnection, label: &str) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, workspace_id FROM windows WHERE label = ?1",
            [label],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((window_id, workspace_id)) = row else { return Ok(None) };

    let sibling_open_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM windows WHERE workspace_id = ?1 AND is_open = 1 AND id != ?2",
            rusqlite::params![workspace_id, window_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if sibling_open_count > 0 {
        // Se archivan sus tabs antes de borrar la ventana (cascada windows→tabs) — mismo
        // motivo que en `delete_workspace_windows`.
        let mut tab_ids_stmt = conn
            .prepare("SELECT id FROM tabs WHERE window_id = ?1")
            .map_err(|e| e.to_string())?;
        let tab_ids: Vec<String> = tab_ids_stmt
            .query_map([&window_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(tab_ids_stmt);
        for tab_id in &tab_ids {
            archive_tab_row(&conn, tab_id, &workspace_id)?;
        }

        conn.execute("DELETE FROM windows WHERE id = ?1", [&window_id])
            .map_err(|e| e.to_string())?;
        Ok(None)
    } else {
        conn.execute("UPDATE windows SET is_open = 0 WHERE id = ?1", [&window_id])
            .map_err(|e| e.to_string())?;
        Ok(Some(workspace_id))
    }
}

/// Crea la fila de una ventana en blanco (sin tabs) para un workspace específico y
/// devuelve el label a usar para la ventana nativa correspondiente. Usado cuando un
/// workspace se queda en cero ventanas vivas mientras el proceso sigue corriendo (otras
/// ventanas de otros workspaces siguen abiertas) — así el workspace no desaparece de la
/// vista silenciosamente, queda con una ventana lista para usar.
pub fn create_blank_window_row(db: &DbConnection, workspace_id: &str) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let label = format!("cc-window-{millis}");
    conn.execute(
        "INSERT INTO windows (id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active)
         VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, NULL, 1, ?4)",
        rusqlite::params![Uuid::new_v4().to_string(), label, workspace_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(label)
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
