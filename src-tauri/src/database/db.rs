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
/// por primera vez, tal como la reporta el frontend, sin depender de cuándo se persistió
/// la fila).
fn needs_schema_v6(conn: &Connection) -> bool {
    conn.prepare("SELECT opened_at FROM tabs LIMIT 1").is_err()
}

pub fn init_db() -> SqlResult<DbConnection> {
    let conn = Connection::open(db_path())?;

    // SQLite trae el enforcement de FK apagado por defecto en cada conexión — sin esto,
    // todos los `ON DELETE CASCADE` del schema (workspaces→windows→tabs→project_skills,
    // skills→project_skills, workspaces→session_history) son un no-op silencioso: borrar
    // un workspace/ventana/skill deja filas huérfanas en las tablas hijas para siempre
    // en vez de limpiarlas.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

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
             -- Entrada de `session_history` de la que salió esta tab (al reabrirla desde
             -- Sesiones). Es lo que hace que volver a cerrarla ACTUALICE esa entrada en vez
             -- de crear una nueva: sin esto, una sesión sin `session_id` resuelto se
             -- duplicaba en el historial en cada ciclo de abrir/cerrar.
             history_id      TEXT,
             -- Cuenta (perfil) de la TUI con la que corre esta tab; NULL = la del sistema.
             -- Ver `accounts`. Se guarda el id y no las variables ya resueltas: si la
             -- cuenta se renombra o se muda de carpeta, la tab restaurada sigue apuntando
             -- a la cuenta correcta en vez de a una ruta que quedó vieja.
             account_id      TEXT,
             -- Cadena de comandos a ejecutar antes del agente, como JSON. Guarda
             -- referencias a `prelaunch_presets` (no su texto), por el mismo motivo que
             -- `account_id` guarda el id y no las variables ya resueltas.
             prelaunch       TEXT NOT NULL DEFAULT '[]',
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

         -- TUIs que el usuario agrega a mano (las soportadas de fábrica están hardcodeadas
         -- en `agents::AGENTS`). Vive en SQLite y no en el frontend porque Rust necesita
         -- consultarla sin que haya una ventana involucrada: la reconciliación de symlinks
         -- de skills corre al cerrar una ventana, y ahí hay que saber en qué carpeta
         -- guarda sus skills esta TUI. Todos los campos de integración son opcionales —
         -- una TUI con solo label+command sigue siendo válida, simplemente no participa
         -- de resume/skills/sesiones.
         CREATE TABLE IF NOT EXISTS custom_agents (
             id              TEXT PRIMARY KEY,
             label           TEXT NOT NULL,
             command         TEXT NOT NULL,
             -- Argumentos de reanudación con el placeholder {session}, ej. '--resume {session}'
             -- o 'resume {session}' (subcomando). NULL/vacío = esta TUI no reanuda sesiones.
             resume_args     TEXT,
             -- Carpeta de skills RELATIVA al cwd del proyecto, ej. '.agents/skills'.
             skills_dir      TEXT,
             -- Carpeta donde la TUI guarda sus sesiones, ej. '~/.mitui/sessions'.
             sessions_dir    TEXT,
             -- Cómo sacar el id de sesión del archivo encontrado: 'filename' (el nombre del
             -- archivo ES el id) o 'field:<clave>' (buscar esa clave en el JSON/JSONL).
             session_id_from TEXT NOT NULL DEFAULT 'filename',
             -- Variables de entorno extra al lanzar el proceso, como objeto JSON.
             env_json        TEXT NOT NULL DEFAULT '{}',
             created_at      INTEGER NOT NULL
         );

         -- Historial de tabs cerradas ('Sesiones'). A propósito NO tiene FK hacia
         -- `windows`/`tabs` (esas se borran y reescriben constantemente, ver
         -- db_save_window_state) — solo hacia `workspaces(id) ON DELETE CASCADE`, que
         -- únicamente se borra si el workspace entero se elimina. Así sobrevive al reset
         -- del bucket `default` (que borra sus `windows`/`tabs` pero nunca la fila de
         -- `workspaces` en sí). `skills` se denormaliza como JSON (mismo patrón que
         -- `skills.categories`) porque `project_skills.tab_id` sí cascadea con `tabs` y
         -- se perdería en el mismo borrado que dispara este archivo.
         -- Fase 6 — Fuentes de skills remotas (marketplace). `cache_json` guarda la última
         -- lista de skills resuelta por `marketplace::refresh_registry` (ver ese módulo
         -- para el formato) — se sirve desde acá en vez de refetchear en cada
         -- `list_marketplace_skills`, y sobrevive a reinicios de la app.
         CREATE TABLE IF NOT EXISTS registries (
             id           TEXT PRIMARY KEY,
             name         TEXT NOT NULL,
             source_type  TEXT NOT NULL,
             location     TEXT NOT NULL,
             priority     INTEGER NOT NULL DEFAULT 0,
             enabled      INTEGER NOT NULL DEFAULT 1,
             last_fetched INTEGER,
             cache_json   TEXT,
             cache_error  TEXT,
             created_at   INTEGER NOT NULL
         );

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
             -- Cuenta de la TUI con la que corría la sesión (ver `accounts`); NULL = la del
             -- sistema. Sin esto, reabrir una conversación de una cuenta alternativa la
             -- arrancaba con la principal, y el resume no encontraba su transcript —
             -- que vive dentro de la carpeta de la cuenta, no en el home.
             account_id   TEXT,
             -- Ver `tabs.prelaunch`: reabrir una sesión desde el historial tiene que
             -- reproducir el mismo entorno con el que se abrió la primera vez.
             prelaunch    TEXT NOT NULL DEFAULT '[]',
             opened_at    INTEGER NOT NULL,
             closed_at    INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_session_history_workspace ON session_history(workspace_id);

         -- Cuentas adicionales de una misma TUI (ver `accounts`). Cada fila es un
         -- directorio de perfil: lanzar un proceso con la variable de esa TUI apuntada ahí
         -- lo hace correr con esa cuenta. Acá NO hay credenciales — solo la ruta; lo que
         -- guarda el login es la TUI, dentro de esa carpeta.
         --
         -- `dir` se guarda absoluto y no se deriva de (agent_id, name) en cada consulta
         -- porque la carpeta de datos de la app puede cambiar entre versiones o sistemas, y
         -- una cuenta que apunta a donde de verdad quedó su login vale más que una ruta
         -- recalculada que apunte a un directorio vacío.
         CREATE TABLE IF NOT EXISTS agent_accounts (
             id         TEXT PRIMARY KEY,
             agent_id   TEXT NOT NULL,
             name       TEXT NOT NULL,
             dir        TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             UNIQUE (agent_id, name)
         );

         -- Comandos de pre-lanzamiento guardados ('entorno conda' → 'conda activate ml').
         -- Son globales y no por agente: un `conda activate` sirve igual para cualquier
         -- TUI. El nombre es único porque es lo que `ccode --pre-preset` recibe.
         CREATE TABLE IF NOT EXISTS prelaunch_presets (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL UNIQUE,
             command    TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )?;

    // Columna agregada después de que `tabs` ya existía en instalaciones reales, así que
    // se suma con ALTER en vez de recrear la tabla (que perdería las tabs guardadas).
    if conn.prepare("SELECT history_id FROM tabs LIMIT 1").is_err() {
        conn.execute("ALTER TABLE tabs ADD COLUMN history_id TEXT", [])?;
    }
    if conn.prepare("SELECT account_id FROM tabs LIMIT 1").is_err() {
        conn.execute("ALTER TABLE tabs ADD COLUMN account_id TEXT", [])?;
    }
    if conn.prepare("SELECT account_id FROM session_history LIMIT 1").is_err() {
        conn.execute("ALTER TABLE session_history ADD COLUMN account_id TEXT", [])?;
    }
    // Cadena de pre-lanzamiento de la tab, como JSON (ver `prelaunch::steps_to_json`). Se
    // guardan referencias a los presets y no su texto ya resuelto: editar un preset
    // después alcanza a las tabs guardadas, en vez de dejarlas con una copia vieja.
    // Va con DEFAULT '[]' y NOT NULL para que leerla nunca tenga que distinguir vacío de
    // nulo.
    if conn.prepare("SELECT prelaunch FROM tabs LIMIT 1").is_err() {
        conn.execute("ALTER TABLE tabs ADD COLUMN prelaunch TEXT NOT NULL DEFAULT '[]'", [])?;
    }
    if conn.prepare("SELECT prelaunch FROM session_history LIMIT 1").is_err() {
        conn.execute(
            "ALTER TABLE session_history ADD COLUMN prelaunch TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if conn.prepare("SELECT sibling_tabs FROM session_history LIMIT 1").is_err() {
        conn.execute(
            "ALTER TABLE session_history ADD COLUMN sibling_tabs TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }

    // Repo del que salió cada skill. `registry_name` va desnormalizado a propósito (misma
    // idea que `agent_label` en `session_history`): el badge tiene que seguir diciendo de
    // dónde vino aunque después borres ese repositorio de tus fuentes.
    //
    // Con ALTER y no recreando la tabla: las skills instaladas viven en disco y sus filas
    // son lo único que las conecta con sus symlinks. Las que ya estaban quedan en NULL —
    // se muestran como locales hasta que se reinstalen.
    if conn.prepare("SELECT registry_id FROM skills LIMIT 1").is_err() {
        conn.execute("ALTER TABLE skills ADD COLUMN registry_id TEXT", [])?;
        conn.execute("ALTER TABLE skills ADD COLUMN registry_name TEXT", [])?;
    }

    ensure_default_workspace(&conn)?;
    ensure_default_settings(&conn)?;
    ensure_default_registries(&conn)?;
    dedupe_session_history(&conn)?;

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

/// Siembra el registry público de ejemplo listado en plan.md (Fase 6) la primera vez que
/// arranca la app, para que el marketplace no se vea vacío antes de que el usuario agregue
/// el suyo. Sin `cache_json` todavía — se resuelve recién cuando el usuario visita la
/// página de Marketplace y dispara el primer refresh (evita pegarle a la red en cada
/// arranque). Solo se siembra si la tabla está vacía, nunca pisa registries que el usuario
/// ya haya agregado o borrado a propósito.
fn ensure_default_registries(conn: &Connection) -> SqlResult<()> {
    let has_any: i64 = conn.query_row("SELECT COUNT(*) FROM registries", [], |r| r.get(0))?;
    if has_any == 0 {
        let now = now_ts();
        // `priority` define el orden en que se agregan las skills en el marketplace:
        // autoskills va primero por ser el repo oficial de la app.
        for &(priority, name, location) in DEFAULT_REGISTRIES {
            conn.execute(
                "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
                 VALUES (?1, ?2, 'github', ?3, ?4, 1, ?5)",
                rusqlite::params![Uuid::new_v4().to_string(), name, location, priority, now],
            )?;
        }
    }
    Ok(())
}

/// Repos preconfigurados al primer arranque (`priority`, nombre visible, `owner/repo`).
/// Solo se siembran si la tabla está vacía — quitarlos después es decisión del usuario y
/// no se vuelven a insertar.
const DEFAULT_REGISTRIES: &[(i32, &str, &str)] = &[
    (0, "autoskills (midudev)", "midudev/autoskills"),
    (1, "anthropics/skills", "anthropics/skills"),
];

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
    /// Entrada de `session_history` de la que salió esta tab (ver el schema de `tabs`).
    pub history_id: Option<String>,
    /// Cuenta de la TUI con la que corre esta tab; `None` = la del sistema.
    pub account_id: Option<String>,
    /// Cadena de comandos a ejecutar antes del agente (ver el módulo `prelaunch`).
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
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
    pub history_id: Option<String>,
    pub account_id: Option<String>,
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
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
        history_id: row.get(11)?,
        account_id: row.get(12)?,
        prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(13)?),
        opened_at: row.get(14)?,
        created_at: row.get(15)?,
        last_active: row.get(16)?,
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

    let affected_dirs = crate::skills::link_dirs_of_workspace(&conn, workspace_id);

    conn.execute("DELETE FROM windows WHERE workspace_id = ?1", [workspace_id])
        .map_err(|e| e.to_string())?;

    crate::skills::reconcile_link_dirs(&conn, &affected_dirs);
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
    .map_err(|e| {
        // `workspaces.name` es UNIQUE: sin esto el usuario veía el error crudo de SQLite
        // ("UNIQUE constraint failed: workspaces.name") en un toast.
        if e.to_string().contains("UNIQUE") {
            format!("Ya existe un workspace llamado \"{name}\"")
        } else {
            e.to_string()
        }
    })?;

    move_open_windows_to_workspace(&conn, &id, &source_workspace_id, now)?;

    Ok(Workspace { id, name, created_at: now, last_active: now })
}

/// Mueve al workspace `new_id` las ventanas abiertas de `source_id` — y, con ellas, los
/// attachments de skills que les corresponden.
///
/// Mover las ventanas sin mover `project_skills` era un bug silencioso:
/// `desired_skills_for_link_dir` resuelve qué symlinks van en cada carpeta uniendo
/// `project_skills.workspace_id = windows.workspace_id`. Si las filas de skills se quedan
/// apuntando al workspace de origen, ese JOIN deja de matchear, y en la primera
/// reconciliación (abrir una tab, cerrar una ventana, el health check al abrir el
/// workspace) los symlinks se borran del proyecto. O sea: guardar un workspace le sacaba
/// todas sus skills, sin ningún error visible.
///
/// Los attachments se mueven, no se copian: el origen típico es el bucket `default`, que
/// es scratch y se resetea — dejar filas ahí resucitaría esas skills más adelante en tabs
/// sin ninguna relación con este workspace.
fn move_open_windows_to_workspace(
    conn: &Connection,
    new_id: &str,
    source_id: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE windows SET workspace_id = ?1, last_active = ?2 WHERE workspace_id = ?3 AND is_open = 1",
        rusqlite::params![new_id, now, source_id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE project_skills SET workspace_id = ?1
         WHERE workspace_id = ?2 AND scope = 'workspace'",
        rusqlite::params![new_id, source_id],
    )
    .map_err(|e| e.to_string())?;

    // Las de scope='tab' solo si su tab viajó de verdad: una tab que quedó en una ventana
    // cerrada (is_open = 0, no incluida en el UPDATE de arriba) sigue perteneciendo al
    // workspace de origen y su attachment debe quedarse con ella.
    conn.execute(
        "UPDATE project_skills SET workspace_id = ?1
         WHERE workspace_id = ?2 AND scope = 'tab' AND tab_id IN (
             SELECT t.id FROM tabs t
             JOIN windows w ON w.id = t.window_id
             WHERE w.workspace_id = ?1
         )",
        rusqlite::params![new_id, source_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn db_get_workspace_windows(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<WindowRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            // ORDER BY last_active: el frontend usa la primera fila para decidir qué
            // ventana enfocar cuando el workspace ya tiene varias vivas (focusIfOpen) —
            // sin orden explícito, la fila que llegaba primero era arbitraria (orden de
            // inserción de SQLite), no necesariamente la usada más recientemente.
            "SELECT id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active
             FROM windows WHERE workspace_id = ?1 AND is_open = 1
             ORDER BY last_active DESC",
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
    let affected_dirs = crate::skills::link_dirs_of_workspace(&conn, &workspace_id);
    conn.execute(
        "UPDATE windows SET is_open = 0 WHERE workspace_id = ?1",
        [&workspace_id],
    )
    .map_err(|e| e.to_string())?;
    crate::skills::reconcile_link_dirs(&conn, &affected_dirs);
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
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("Ya existe un workspace llamado \"{name}\"")
            } else {
                e.to_string()
            }
        })?;
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
/// Margen hacia atrás al re-descubrir la sesión: los mtime tienen resolución de 1s y el
/// reloj del archivado no es el mismo instante que el de `pty_create` (mismo motivo que
/// `SESSION_DISCOVERY_LOOKBACK_S` en el frontend).
const REDISCOVERY_LOOKBACK_S: i64 = 3;

/// Qué sesión estuvo usando REALMENTE esta tab, mirando el disco en el momento de cerrarla.
///
/// Devuelve el id que corresponde archivar: el re-descubierto si hay uno mejor, o el que ya
/// tenía la tab. Nunca devuelve `None` habiendo un id previo — no encontrar nada significa
/// "no sé", no "no tenía sesión".
fn reconcile_session_id(
    conn: &Connection,
    tab_id: &str,
    agent_id: &str,
    cwd: &str,
    current: Option<String>,
    account_id: Option<&str>,
    opened_at: i64,
) -> Option<String> {
    let profile = account_id.and_then(|id| crate::accounts::dir_for_conn(conn, id));
    let custom = crate::agents::find(conn, agent_id);

    let found = crate::session::discover_session_id_sync(
        agent_id,
        cwd,
        opened_at - REDISCOVERY_LOOKBACK_S,
        profile.as_deref().map(std::path::Path::new),
        custom.as_ref(),
    );

    // Traza deliberada: este camino solo se puede observar con una TUI real retomando una
    // conversación real, algo que no se puede reproducir en un test. Sale por stderr, así
    // que en `tauri dev` aparece en la terminal desde donde se levantó la app.
    eprintln!(
        "[sesión] al cerrar {tab_id}: agente={agent_id} guardada={current:?} encontrada={found:?}"
    );

    let Some(found) = found else { return current };
    if Some(&found) == current.as_ref() {
        return current;
    }

    // Con dos tabs del mismo agente en la misma carpeta, "el archivo más nuevo" puede ser
    // el de la OTRA tab. Robarle su sesión sería peor que no reconciliar: quedarían dos
    // entradas del historial apuntando a la misma conversación.
    let taken: Result<i64, _> = conn.query_row(
        "SELECT COUNT(*) FROM tabs WHERE id != ?1 AND session_id = ?2",
        rusqlite::params![tab_id, found],
        |r| r.get(0),
    );
    if taken.unwrap_or(0) > 0 {
        eprintln!("[sesión] {found} ya es de otra tab abierta — se conserva {current:?}");
        return current;
    }

    eprintln!("[sesión] la tab había cambiado de conversación: {current:?} → {found}");
    Some(found)
}

fn archive_tab_row(conn: &Connection, tab_id: &str, workspace_id: &str) -> Result<(), String> {
    #[allow(clippy::type_complexity)]
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, String, i64, bool)> = conn
        .query_row(
            "SELECT agent_id, agent_label, command, cwd, title, session_id, history_id, account_id, prelaunch, opened_at, title_is_custom FROM tabs WHERE id = ?1",
            [tab_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get::<_, i64>(10)? != 0)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((
        agent_id,
        agent_label,
        command,
        cwd,
        title,
        session_id,
        history_id,
        account_id,
        prelaunch,
        opened_at,
        title_is_custom,
    )) = row
    else { return Ok(()) };

    // El id de sesión que trae la tab es el que se descubrió al ARRANCAR. Si el usuario
    // retomó otra conversación desde adentro de la TUI (`/resume` de Claude y equivalentes),
    // la tab estuvo trabajando sobre una sesión distinta, y archivar con el id viejo crea
    // una entrada nueva en vez de actualizar la conversación que de verdad se continuó.
    //
    // Acá es el único punto por el que pasan TODOS los cierres (cerrar la tab, cerrar la
    // ventana, salir de la app), así que reconciliar acá lo cubre todo de una vez.
    let session_id = reconcile_session_id(
        conn, tab_id, &agent_id, &cwd, session_id, account_id.as_deref(), opened_at,
    );

    // El título se resuelve ACÁ, contra la sesión real, y no se confía en el que traía la
    // tab. Dos motivos, los dos verificados sobre un historial de verdad:
    //
    // - Si la sesión resultó ser otra, el título de la tab es el de la conversación
    //   equivocada — y como el archivado ACTUALIZA la entrada existente, escribirlo le
    //   pisaría el título bueno a la conversación que se retomó.
    // - El refresco de título del frontend solo corre al cerrar la tab a mano; una tab que
    //   se va con la ventana o con la app se archivaba con el título de relleno
    //   ("Claude Code — carpeta"). En una base real eso era el 100% de las entradas.
    //
    // Un título puesto a mano por el usuario manda siempre y no se toca.
    let title = if !title_is_custom {
        let profile = account_id
            .as_deref()
            .and_then(|id| crate::accounts::dir_for_conn(conn, id));
        let custom = crate::agents::find(conn, &agent_id);
        Some(
            crate::session::get_session_title_sync(
                &agent_id,
                &cwd,
                session_id.clone(),
                title.clone().unwrap_or_default(),
                profile.as_deref().map(std::path::Path::new),
                custom.as_ref(),
            )
            .title,
        )
        .filter(|t| !t.is_empty())
        .or(title)
    } else {
        title
    };

    // Skills activas para esta tab al momento de archivar: por-tab (scope='tab') o
    // por-workspace (scope='workspace'). Se "congelan" acá porque `project_skills.tab_id`
    // cascadea con `tabs` y desaparecería en el mismo borrado que dispara este archivo.
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT s.id, s.name, ps.scope FROM project_skills ps
             JOIN skills s ON s.id = ps.skill_id
             WHERE ps.enabled = 1 AND (
               (ps.scope = 'tab' AND ps.tab_id = ?1) OR
               (ps.scope = 'workspace' AND ps.workspace_id = ?2)
             )",
        )
        .map_err(|e| e.to_string())?;
    let archived: Vec<ArchivedSkill> = stmt
        .query_map(rusqlite::params![tab_id, workspace_id], |r| {
            Ok(ArchivedSkill { id: r.get(0)?, name: r.get(1)?, scope: r.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let skills_json = serde_json::to_string(&archived).unwrap_or_else(|_| "[]".to_string());

    // Con qué otras tabs del workspace convivía esta al cerrarse — el "junto a qué estaba
    // trabajando" que pide la vista de historial. Es una foto del momento del archivado:
    // si se cierran varias tabs a la vez, cada una registra las que todavía no se
    // archivaron, así que la última en cerrarse ve menos hermanas que la primera.
    let siblings: Vec<SiblingTab> = {
        let mut stmt = conn
            .prepare(
                "SELECT t.title, t.agent_label, t.cwd FROM tabs t
                 JOIN windows w ON w.id = t.window_id
                 WHERE w.workspace_id = ?1 AND t.id != ?2
                 ORDER BY t.tab_order ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_id, tab_id], |r| {
                Ok(SiblingTab { title: r.get(0)?, agent_label: r.get(1)?, cwd: r.get(2)? })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let siblings_json = serde_json::to_string(&siblings).unwrap_or_else(|_| "[]".to_string());

    let now = now_ts();

    // A qué entrada del historial corresponde esta tab, en orden de confianza:
    //
    // 1. `history_id` — la tab se abrió DESDE el historial, así que sabemos exactamente
    //    cuál actualizar. Es el único camino que funciona para sesiones que nunca
    //    resolvieron un `session_id` (bash, o un agente cuyo id no se llegó a descubrir):
    //    sin esto, cada ciclo de abrir/cerrar insertaba una fila nueva.
    // 2. `session_id` — misma conversación real del agente, aunque la tab sea otra.
    // 3. Sin ninguno de los dos, y sin id de sesión que la distinga, una tab del mismo
    //    agente en la misma carpeta es indistinguible de la anterior: se actualiza esa
    //    entrada en vez de acumular copias.
    let existing_id: Option<String> = if let Some(hid) = &history_id {
        conn.query_row("SELECT id FROM session_history WHERE id = ?1", [hid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
    } else if let Some(sid) = &session_id {
        conn.query_row("SELECT id FROM session_history WHERE session_id = ?1", [sid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
    } else {
        conn.query_row(
            "SELECT id FROM session_history
             WHERE workspace_id = ?1 AND agent_id = ?2 AND cwd = ?3 AND session_id IS NULL
             ORDER BY closed_at DESC LIMIT 1",
            rusqlite::params![workspace_id, agent_id, cwd],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };

    if let Some(hid) = existing_id {
        // opened_at NO se toca: representa cuándo se abrió esa conversación por
        // primera vez, no la última vez que se retomó/cerró.
        //
        // `session_id` sí se escribe: una sesión que se archivó sin id y lo resolvió al
        // reabrirse tiene que quedar identificada de acá en adelante.
        conn.execute(
            "UPDATE session_history SET agent_id=?1, agent_label=?2, command=?3, cwd=?4, title=?5, session_id=COALESCE(?6, session_id), skills=?7, sibling_tabs=?8, account_id=?9, prelaunch=?10, closed_at=?11 WHERE id=?12",
            rusqlite::params![agent_id, agent_label, command, cwd, title, session_id, skills_json, siblings_json, account_id, prelaunch, now, hid],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    conn.execute(
        "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            siblings_json,
            account_id,
            prelaunch,
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
    pub skills: Vec<ArchivedSkill>,
    /// Otras tabs del workspace que estaban abiertas al cerrar esta.
    pub sibling_tabs: Vec<SiblingTab>,
    /// Cuenta de la TUI con la que corría; `None` = la del sistema.
    pub account_id: Option<String>,
    /// Cadena de pre-lanzamiento con la que se abrió, para poder reproducirla al reabrir.
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
    pub opened_at: i64,
    pub closed_at: i64,
}

/// Tab que convivía con la sesión archivada, para poder mostrar con qué configuración de
/// tabs se estaba trabajando en ese momento.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiblingTab {
    pub title: Option<String>,
    pub agent_label: String,
    pub cwd: String,
}

/// Una skill tal como estaba activa en la tab en el momento de cerrarla. Se guarda el
/// `id` para poder reattachear exactamente la misma copia instalada, y el `name` para
/// poder reconocerla (o buscarla en el marketplace) si esa copia ya no existe.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSkill {
    pub id: String,
    pub name: String,
    /// 'tab' o 'workspace' — con qué alcance estaba attacheada.
    pub scope: String,
}

/// Colapsa las entradas duplicadas que dejó la versión anterior: cada vez que se reabría
/// y volvía a cerrar una sesión SIN `session_id` resuelto se insertaba una fila nueva en
/// vez de actualizar la existente, así que el historial mostraba N copias de la misma
/// conversación.
///
/// Dos filas son la misma sesión si comparten workspace + agente + carpeta + `session_id`
/// (tratando NULL como "sin id"). De cada grupo sobrevive la cerrada más recientemente —
/// la que tiene el título y las skills más actuales — pero heredando el `opened_at` más
/// viejo del grupo, que es cuándo empezó realmente la conversación.
fn dedupe_session_history(conn: &Connection) -> SqlResult<()> {
    // El opened_at se normaliza ANTES de borrar: después ya no habría de dónde sacarlo.
    conn.execute(
        "UPDATE session_history SET
           opened_at = (SELECT MIN(h2.opened_at) FROM session_history h2
                        WHERE h2.workspace_id = session_history.workspace_id
                          AND h2.agent_id = session_history.agent_id
                          AND h2.cwd = session_history.cwd
                          AND COALESCE(h2.session_id, '') = COALESCE(session_history.session_id, ''))",
        [],
    )?;

    // `rowid` desempata para que el resultado sea determinista si dos filas del mismo
    // grupo comparten `closed_at`.
    conn.execute(
        "DELETE FROM session_history WHERE rowid NOT IN (
           SELECT (
             SELECT h2.rowid FROM session_history h2
             WHERE h2.workspace_id = h.workspace_id
               AND h2.agent_id = h.agent_id
               AND h2.cwd = h.cwd
               AND COALESCE(h2.session_id, '') = COALESCE(h.session_id, '')
             ORDER BY h2.closed_at DESC, h2.rowid DESC
             LIMIT 1
           )
           FROM session_history h
         )",
        [],
    )?;
    Ok(())
}

/// Skills archivadas de una entrada del historial, sobre una conexión ya lockeada.
pub fn archived_skills_of_session(
    conn: &Connection,
    history_id: &str,
) -> Result<Vec<ArchivedSkill>, String> {
    let json: Option<String> = conn
        .query_row("SELECT skills FROM session_history WHERE id = ?1", [history_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(json.as_deref().map(parse_archived_skills).unwrap_or_default())
}

/// Lee la columna `skills` de `session_history` tolerando el formato viejo, que era un
/// array plano de nombres (`["git-helper"]`) sin id ni scope. Esas entradas se leen como
/// skills sin id: se pueden mostrar y buscar por nombre, pero no reattachear directo.
fn parse_archived_skills(json: &str) -> Vec<ArchivedSkill> {
    if let Ok(v) = serde_json::from_str::<Vec<ArchivedSkill>>(json) {
        return v;
    }
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|name| ArchivedSkill { id: String::new(), name, scope: "tab".to_string() })
        .collect()
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
            "SELECT id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at
             FROM session_history WHERE workspace_id = ?1 ORDER BY closed_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([&workspace_id], |row| {
            let skills_json: String = row.get(8)?;
            let skills = parse_archived_skills(&skills_json);
            let siblings_json: String = row.get(9)?;
            let sibling_tabs: Vec<SiblingTab> =
                serde_json::from_str(&siblings_json).unwrap_or_default();
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
                sibling_tabs,
                account_id: row.get(10)?,
                prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(11)?),
                opened_at: row.get(12)?,
                closed_at: row.get(13)?,
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

/// Borra una entrada del historial. No toca el archivo de sesión del agente en disco
/// (vive fuera de la app, en `~/.claude/projects` y equivalentes): esto solo saca la
/// sesión de la vista de Sesiones.
#[tauri::command]
pub fn db_delete_session_history(
    history_id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM session_history WHERE id = ?1", [&history_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Una entrada puntual del historial, sobre una conexión ya lockeada — la usa el
/// exportador a markdown, que necesita toda la metadata de la sesión.
pub fn session_history_entry(
    conn: &Connection,
    history_id: &str,
) -> Result<Option<SessionHistoryEntry>, String> {
    conn.query_row(
        "SELECT id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at
         FROM session_history WHERE id = ?1",
        [history_id],
        |row| {
            let skills_json: String = row.get(8)?;
            let siblings_json: String = row.get(9)?;
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                agent_id: row.get(2)?,
                agent_label: row.get(3)?,
                command: row.get(4)?,
                cwd: row.get(5)?,
                title: row.get(6)?,
                session_id: row.get(7)?,
                skills: parse_archived_skills(&skills_json),
                sibling_tabs: serde_json::from_str(&siblings_json).unwrap_or_default(),
                account_id: row.get(10)?,
                prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(11)?),
                opened_at: row.get(12)?,
                closed_at: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Nombre del workspace al que pertenece una sesión — para el encabezado del export.
pub fn workspace_name(conn: &Connection, workspace_id: &str) -> Option<String> {
    conn.query_row("SELECT name FROM workspaces WHERE id = ?1", [workspace_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Busca si esta conversación ya está abierta en alguna tab viva (ventana `is_open = 1`)
/// de ESE workspace — usado por "Reabrir" en Sesiones: si ya está abierta en algún lado,
/// hay que enfocar esa tab en vez de abrir un duplicado.
///
/// Se busca por DOS caminos, y hacen falta los dos:
///
/// - `session_id` es el identificador real de la conversación, pero **puede ser NULL**: hay
///   sesiones que nunca llegan a resolverlo (la TUI no escribió su transcript todavía, o no
///   expone uno). Con solo este criterio, esas sesiones se duplicaban en cada reapertura.
/// - `history_id` es la entrada del historial de la que salió la tab. Una tab reabierta
///   desde Sesiones lo lleva puesto, así que identifica el caso que importa acá incluso sin
///   id de sesión.
#[tauri::command]
pub fn find_open_tab_for_session(
    session_id: Option<String>,
    history_id: Option<String>,
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<OpenTabLocation>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    open_tab_for_session(&conn, session_id.as_deref(), history_id.as_deref(), &workspace_id)
        .map_err(|e| e.to_string())
}

/// La búsqueda en sí, separada del comando para poder probarla.
fn open_tab_for_session(
    conn: &Connection,
    session_id: Option<&str>,
    history_id: Option<&str>,
    workspace_id: &str,
) -> rusqlite::Result<Option<OpenTabLocation>> {
    if session_id.is_none() && history_id.is_none() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT w.label, t.id FROM tabs t
         JOIN windows w ON w.id = t.window_id
         WHERE w.workspace_id = ?3 AND w.is_open = 1
           AND ((?1 IS NOT NULL AND t.session_id = ?1)
             OR (?2 IS NOT NULL AND t.history_id = ?2))
         LIMIT 1",
        rusqlite::params![session_id, history_id, workspace_id],
        |row| Ok(OpenTabLocation { window_label: row.get(0)?, tab_id: row.get(1)? }),
    )
    .optional()
}

// ── Commands: windows + tabs (estado de sesión) ──────────────────

/// Guarda el estado de la ventana (posición, tamaño, tabs) y archiva las tabs que
/// desaparecieron del payload.
///
/// En `spawn_blocking` porque el archivado re-descubre la sesión real de cada tab que se
/// cierra (ver `reconcile_session_id`), y para OpenCode eso levanta un proceso (~0.9s
/// medidos). Corriendo síncrono, cerrar una tab —o salir con varias abiertas— congelaba la
/// interfaz ese tiempo. Es el mismo tratamiento que ya tienen `discover_session_id` y
/// `detect_agents`, por el mismo motivo.
#[tauri::command]
pub async fn db_save_window_state(
    state: WindowStatePayload,
    db: tauri::State<'_, DbConnection>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || db_save_window_state_sync(state, &db, &app))
        .await
        .map_err(|e| e.to_string())?
}

fn db_save_window_state_sync(
    state: WindowStatePayload,
    db: &DbConnection,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    // Un guardado de una ventana que ya no existe nativamente es un guardado zombi: el
    // JS de una ventana en pleno teardown (o cuyo timer periódico de 20s disparó justo
    // durante el cierre) puede llegar acá después de que su fila se borró a propósito.
    // Como el INSERT de abajo recrea la fila con `is_open = 1`, eso resucitaba ventanas
    // que se acababan de descartar — el caso visible es "Nuevo workspace": se borran las
    // filas de `default` y un guardado en vuelo devolvía una de ellas a la vida, con sus
    // tabs, en el workspace supuestamente vacío.
    if tauri::Manager::get_webview_window(app, &state.label).is_none() {
        return Ok(());
    }

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

    // Directorios de skills que quedan sin dueño al desaparecer estas tabs — se
    // reconcilian al final, ya con las filas borradas (ver `skills::reconcile_link_dir`).
    let mut orphaned_dirs: Vec<(String, String)> = Vec::new();
    for closed_id in existing_ids.iter().filter(|id| !incoming_ids.contains(id.as_str())) {
        archive_tab_row(&conn, closed_id, &state.workspace_id)?;
        if let Ok(pair) = conn.query_row(
            "SELECT cwd, agent_id FROM tabs WHERE id = ?1",
            [closed_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ) {
            orphaned_dirs.push(pair);
        }
        conn.execute("DELETE FROM tabs WHERE id = ?1", [closed_id]).map_err(|e| e.to_string())?;
    }

    // Upsert por id en vez de borrar todas las tabs de la ventana y reinsertarlas: con
    // `PRAGMA foreign_keys = ON`, ese borrado disparaba el `ON DELETE CASCADE` de
    // `project_skills.tab_id` y se llevaba puestos TODOS los attachments de scope='tab'
    // en cada autosave (cada ~400ms), o sea que una skill asignada a una tab puntual
    // dejaba de estar asignada casi de inmediato. Al no borrar la fila, el id de la tab
    // es estable y el attachment sobrevive hasta que la tab se cierra de verdad (arriba).
    for t in &state.tabs {
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, history_id, account_id, prelaunch, opened_at, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
             ON CONFLICT(id) DO UPDATE SET
               window_id = excluded.window_id,
               title = excluded.title,
               title_is_custom = excluded.title_is_custom,
               agent_id = excluded.agent_id,
               agent_label = excluded.agent_label,
               command = excluded.command,
               cwd = excluded.cwd,
               tab_order = excluded.tab_order,
               session_id = excluded.session_id,
               scrollback = excluded.scrollback,
               history_id = excluded.history_id,
               account_id = excluded.account_id,
               prelaunch = excluded.prelaunch,
               last_active = excluded.last_active",
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
                t.history_id,
                t.account_id,
                crate::prelaunch::steps_to_json(&t.prelaunch),
                t.opened_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    crate::skills::reconcile_link_dirs(&conn, &orphaned_dirs);

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
            "SELECT id, window_id, title, title_is_custom, agent_id, agent_label, command, cwd, tab_order, session_id, scrollback, history_id, account_id, prelaunch, opened_at, created_at, last_active
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

    let window_id: Option<String> = conn
        .query_row("SELECT id FROM windows WHERE label = ?1", [&label], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    conn.execute("UPDATE windows SET is_open = 0 WHERE label = ?1", [&label])
        .map_err(|e| e.to_string())?;

    // Las tabs siguen guardadas (la ventana es restaurable) pero ya no están corriendo:
    // sus symlinks de skills salen del proyecto para no filtrarse al próximo workspace
    // que abra esa misma carpeta. Se recrean al restaurar, vía `reconcile_tab_skills`.
    if let Some(window_id) = window_id {
        let dirs = crate::skills::link_dirs_of_window(&conn, &window_id);
        crate::skills::reconcile_link_dirs(&conn, &dirs);
    }

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
/// (el caso "preservado", fila conservada con `is_open = 0`), y `None` si la fila se borró
/// (todavía quedan otras ventanas del mismo workspace) o si el label no existía. Es
/// informativo: cerrar una ventana nunca abre otra en su lugar (ver
/// `close_and_forget_window`).
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

    // Los directorios de skills de sus tabs se anotan antes de tocar nada: en ambas ramas
    // (borrar la ventana o marcarla cerrada) esas tabs dejan de estar vivas y sus
    // symlinks tienen que salir del proyecto.
    let affected_dirs = crate::skills::link_dirs_of_window(&conn, &window_id);

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
        crate::skills::reconcile_link_dirs(&conn, &affected_dirs);
        Ok(None)
    } else {
        conn.execute("UPDATE windows SET is_open = 0 WHERE id = ?1", [&window_id])
            .map_err(|e| e.to_string())?;
        crate::skills::reconcile_link_dirs(&conn, &affected_dirs);
        Ok(Some(workspace_id))
    }
}

/// Label nuevo para una ventana nativa, único por construcción.
///
/// Antes esto era `format!("cc-window-{millis}")` en cuatro lugares distintos, y el
/// timestamp en milisegundos NO alcanza: al restaurar un workspace se renombran varias
/// filas dentro del mismo loop, y dos que caen en el mismo milisegundo producían el mismo
/// label. Como `windows.label` es UNIQUE y el label de una ventana nativa es único a nivel
/// de proceso, eso hacía fallar el INSERT/UPDATE o el `build()` de la segunda ventana —
/// abortando la restauración entera con `?` y dejando al usuario sin el resto de sus
/// ventanas. El sufijo aleatorio elimina la colisión sin depender del reloj.
pub fn fresh_window_label() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix = Uuid::new_v4().simple().to_string();
    format!("cc-window-{millis}-{}", &suffix[..8])
}

/// Crea la fila de una ventana en blanco (sin tabs) para un workspace específico y
/// devuelve el label a usar para la ventana nativa correspondiente. Usado cuando un
/// workspace se queda en cero ventanas vivas mientras el proceso sigue corriendo (otras
/// ventanas de otros workspaces siguen abiertas) — así el workspace no desaparece de la
/// vista silenciosamente, queda con una ventana lista para usar.
pub fn create_blank_window_row(db: &DbConnection, workspace_id: &str) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();
    let label = fresh_window_label();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn history_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM session_history", [], |r| r.get(0)).unwrap()
    }

    /// Schema mínimo para ejercitar el archivado: solo las tablas que toca.
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
             CREATE TABLE windows (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 1, last_active INTEGER NOT NULL);
             CREATE TABLE tabs (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, title TEXT, title_is_custom INTEGER NOT NULL DEFAULT 0, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, tab_order INTEGER NOT NULL DEFAULT 0, session_id TEXT, scrollback TEXT, history_id TEXT, account_id TEXT, prelaunch TEXT NOT NULL DEFAULT '[]', opened_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
             CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_path TEXT NOT NULL);
             CREATE TABLE project_skills (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL, tab_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
             CREATE TABLE session_history (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT, session_id TEXT, skills TEXT NOT NULL DEFAULT '[]', sibling_tabs TEXT NOT NULL DEFAULT '[]', account_id TEXT, prelaunch TEXT NOT NULL DEFAULT '[]', opened_at INTEGER NOT NULL, closed_at INTEGER NOT NULL);
             CREATE TABLE agent_accounts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL, created_at INTEGER NOT NULL);
             INSERT INTO workspaces VALUES ('ws', 'WS', 0, 0);
             INSERT INTO windows VALUES ('win', 'win', 'ws', 1, 0);",
        ).unwrap();
        conn
    }

    /// Reanudar tiene que ENFOCAR la tab existente, no abrir otra. Antes esto solo
    /// funcionaba si la sesión tenía id resuelto, y las que nunca lo resolvieron se
    /// duplicaban en cada reapertura.
    #[test]
    fn una_sesion_ya_abierta_se_encuentra_por_su_id() {
        let conn = setup();
        insert_tab(&conn, "t1", Some("sess-1"), None);
        let found = open_tab_for_session(&conn, Some("sess-1"), Some("h1"), "ws").unwrap();
        assert_eq!(found.unwrap().tab_id, "t1");
    }

    #[test]
    fn una_sesion_sin_id_resuelto_se_encuentra_por_su_entrada_del_historial() {
        let conn = setup();
        insert_tab(&conn, "t1", None, Some("h1"));
        let found = open_tab_for_session(&conn, None, Some("h1"), "ws").unwrap();
        assert_eq!(found.unwrap().tab_id, "t1");
    }

    #[test]
    fn una_sesion_que_no_esta_abierta_no_devuelve_nada() {
        let conn = setup();
        insert_tab(&conn, "t1", Some("otra"), Some("otra-h"));
        assert!(open_tab_for_session(&conn, Some("sess-1"), Some("h1"), "ws").unwrap().is_none());
    }

    /// Sin este corte, `t.session_id = NULL` no matchea nunca pero la rama de historial
    /// podría colar cualquier tab si se pasaran los dos en NULL.
    #[test]
    fn sin_ningun_identificador_no_se_busca() {
        let conn = setup();
        insert_tab(&conn, "t1", None, None);
        assert!(open_tab_for_session(&conn, None, None, "ws").unwrap().is_none());
    }

    #[test]
    fn no_se_enfoca_una_tab_de_una_ventana_cerrada() {
        let conn = setup();
        insert_tab(&conn, "t1", Some("sess-1"), None);
        conn.execute("UPDATE windows SET is_open = 0", []).unwrap();
        assert!(open_tab_for_session(&conn, Some("sess-1"), None, "ws").unwrap().is_none());
    }

    fn insert_tab(conn: &Connection, id: &str, session_id: Option<&str>, history_id: Option<&str>) {
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, session_id, history_id, opened_at, created_at, last_active)
             VALUES (?1, 'win', 'Mi sesión', 'claude-code', 'Claude Code', 'claude', '/proj', ?2, ?3, 100, 0, 0)",
            rusqlite::params![id, session_id, history_id],
        ).unwrap();
    }

    /// Carpeta temporal propia del test, que se borra sola.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("cc-db-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Tab que corre con una cuenta propia. La cuenta es lo que deja apuntar el
    /// descubrimiento a una carpeta de prueba en vez del `~/.claude` real de la máquina.
    fn insert_tab_with_account(
        conn: &Connection,
        id: &str,
        session_id: Option<&str>,
        account_dir: &std::path::Path,
    ) {
        conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at)
             VALUES ('acc', 'claude-code', 'trabajo', ?1, 0)
             ON CONFLICT(id) DO NOTHING",
            [account_dir.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, session_id, account_id, opened_at, created_at, last_active)
             VALUES (?1, 'win', 'Mi sesión', 'claude-code', 'Claude Code', 'claude', '/proj', ?2, 'acc', 100, 0, 0)",
            rusqlite::params![id, session_id],
        )
        .unwrap();
    }

    /// Deja en el perfil un transcript de Claude Code para ese cwd, como si la TUI acabara
    /// de escribirlo.
    fn write_transcript(profile: &std::path::Path, cwd: &str, session_id: &str) {
        let dir = profile.join("projects").join(cwd.replace('/', "-"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{session_id}.jsonl")), "{}\n").unwrap();
    }

    /// Igual, pero con la línea `summary` de la que Claude Code saca el título.
    fn write_transcript_titled(
        profile: &std::path::Path,
        cwd: &str,
        session_id: &str,
        summary: &str,
    ) {
        let dir = profile.join("projects").join(cwd.replace('/', "-"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{session_id}.jsonl")),
            format!("{{\"type\":\"summary\",\"summary\":\"{summary}\"}}\n"),
        )
        .unwrap();
    }

    fn archived_title(conn: &Connection) -> Option<String> {
        conn.query_row("SELECT title FROM session_history", [], |r| r.get(0)).unwrap()
    }

    fn archived_session_id(conn: &Connection) -> Option<String> {
        conn.query_row("SELECT session_id FROM session_history", [], |r| r.get(0)).unwrap()
    }

    /// El bug reportado: retomar una conversación DESDE ADENTRO de la TUI (`/resume`) dejaba
    /// la tab con el id que se descubrió al arrancar, así que al cerrar se archivaba una
    /// sesión nueva y la conversación continuada quedaba sin actualizar.
    #[test]
    fn archiving_follows_a_session_resumed_inside_the_tui() {
        let conn = setup();
        let profile = TempDir::new();
        write_transcript(&profile.0, "/proj", "la-retomada");
        insert_tab_with_account(&conn, "tab-1", Some("la-de-arranque"), &profile.0);

        archive_tab_row(&conn, "tab-1", "ws").unwrap();

        assert_eq!(archived_session_id(&conn).as_deref(), Some("la-retomada"));
    }

    /// Al cambiar de sesión, el título de la tab es el de la conversación abandonada.
    /// Escribirlo pisaría el título bueno de la conversación que se retomó.
    #[test]
    fn archiving_recomputes_the_title_when_the_session_changed() {
        let conn = setup();
        let profile = TempDir::new();
        write_transcript_titled(&profile.0, "/proj", "la-retomada", "Charla retomada");
        insert_tab_with_account(&conn, "tab-1", Some("la-de-arranque"), &profile.0);

        archive_tab_row(&conn, "tab-1", "ws").unwrap();

        assert_eq!(archived_title(&conn).as_deref(), Some("Charla retomada"));
    }

    /// Con dos tabs del mismo agente en la misma carpeta, el archivo más nuevo puede ser el
    /// de la OTRA tab. Robárselo dejaría dos entradas del historial sobre la misma
    /// conversación, que es peor que no reconciliar.
    #[test]
    fn reconciliation_does_not_steal_a_session_owned_by_another_tab() {
        let conn = setup();
        let profile = TempDir::new();
        write_transcript(&profile.0, "/proj", "de-la-otra-tab");
        insert_tab_with_account(&conn, "tab-1", Some("la-mia"), &profile.0);
        insert_tab_with_account(&conn, "tab-2", Some("de-la-otra-tab"), &profile.0);

        archive_tab_row(&conn, "tab-1", "ws").unwrap();

        assert_eq!(archived_session_id(&conn).as_deref(), Some("la-mia"));
    }

    /// No encontrar nada significa "no sé", no "no tenía sesión": el id previo se conserva.
    #[test]
    fn reconciliation_keeps_the_previous_id_when_nothing_is_found() {
        let conn = setup();
        let profile = TempDir::new();
        insert_tab_with_account(&conn, "tab-1", Some("la-unica"), &profile.0);

        archive_tab_row(&conn, "tab-1", "ws").unwrap();

        assert_eq!(archived_session_id(&conn).as_deref(), Some("la-unica"));
    }

    fn attach_skill_row(conn: &Connection, id: &str, ws: &str, scope: &str, tab: Option<&str>) {
        conn.execute(
            "INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
             VALUES (?1, 'skill-1', ?2, ?3, ?4, 1, 0)",
            rusqlite::params![id, ws, scope, tab],
        )
        .unwrap();
    }

    fn workspace_of_attachment(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT workspace_id FROM project_skills WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    }

    /// El bug: "Guardar workspace" movía las ventanas al workspace nuevo pero dejaba los
    /// `project_skills` apuntando al de origen. Como los symlinks se derivan del JOIN
    /// `project_skills.workspace_id = windows.workspace_id`, guardar un workspace le
    /// borraba en silencio todas sus skills en la siguiente reconciliación.
    #[test]
    fn saving_a_workspace_carries_its_skill_attachments_along() {
        let conn = setup();
        conn.execute("INSERT INTO workspaces VALUES ('nuevo', 'Nuevo', 0, 0)", []).unwrap();
        insert_tab(&conn, "tab-1", None, None);

        attach_skill_row(&conn, "ps-ws", "ws", "workspace", None);
        attach_skill_row(&conn, "ps-tab", "ws", "tab", Some("tab-1"));

        move_open_windows_to_workspace(&conn, "nuevo", "ws", 0).unwrap();

        let moved: String = conn
            .query_row("SELECT workspace_id FROM windows WHERE id = 'win'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(moved, "nuevo", "la ventana abierta se mueve al workspace nuevo");
        assert_eq!(workspace_of_attachment(&conn, "ps-ws"), "nuevo");
        assert_eq!(workspace_of_attachment(&conn, "ps-tab"), "nuevo");
    }

    /// La contracara: lo que NO se movió no debe arrastrar sus skills. Una ventana cerrada
    /// se queda en el workspace de origen, así que el attachment de sus tabs también.
    #[test]
    fn attachments_of_windows_that_stayed_behind_are_left_alone() {
        let conn = setup();
        conn.execute("INSERT INTO workspaces VALUES ('nuevo', 'Nuevo', 0, 0)", []).unwrap();
        conn.execute("INSERT INTO windows VALUES ('win-cerrada', 'win-cerrada', 'ws', 0, 0)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
             VALUES ('tab-vieja', 'win-cerrada', 't', 'claude-code', 'Claude Code', 'claude', '/proj', 0, 0, 0)",
            [],
        )
        .unwrap();
        attach_skill_row(&conn, "ps-vieja", "ws", "tab", Some("tab-vieja"));

        move_open_windows_to_workspace(&conn, "nuevo", "ws", 0).unwrap();

        let stayed: String = conn
            .query_row("SELECT workspace_id FROM windows WHERE id = 'win-cerrada'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stayed, "ws", "una ventana cerrada no se lleva al workspace nuevo");
        assert_eq!(
            workspace_of_attachment(&conn, "ps-vieja"),
            "ws",
            "su attachment de scope='tab' se queda con ella"
        );
    }

    /// Dos labels generados en el mismo milisegundo tienen que seguir siendo distintos:
    /// `windows.label` es UNIQUE y el label nativo es único por proceso, así que una
    /// colisión rompía la restauración de todo un workspace.
    #[test]
    fn generated_window_labels_do_not_collide() {
        let labels: std::collections::HashSet<String> =
            (0..500).map(|_| fresh_window_label()).collect();
        assert_eq!(labels.len(), 500);
        assert!(labels.iter().all(|l| l.starts_with("cc-window-")));
    }

    /// El bug reportado: reabrir una sesión desde el historial y volver a cerrarla dejaba
    /// DOS entradas de la misma sesión en vez de actualizar la que ya estaba.
    #[test]
    fn reopening_and_closing_a_session_updates_its_history_entry() {
        for session_id in [None, Some("sess-1")] {
            let conn = setup();

            // Primer ciclo: la tab se abre y se cierra → una entrada.
            insert_tab(&conn, "tab-1", session_id, None);
            archive_tab_row(&conn, "tab-1", "ws").unwrap();
            assert_eq!(history_count(&conn), 1, "el primer cierre crea una sola entrada");

            let (hid, opened_at): (String, i64) = conn
                .query_row("SELECT id, opened_at FROM session_history", [], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            assert_eq!(opened_at, 100);

            // Segundo ciclo: se reabre DESDE el historial (la tab nueva lleva history_id)
            // y se vuelve a cerrar. Debe seguir habiendo una sola entrada.
            conn.execute("DELETE FROM tabs WHERE id = 'tab-1'", []).unwrap();
            insert_tab(&conn, "tab-2", session_id, Some(&hid));
            archive_tab_row(&conn, "tab-2", "ws").unwrap();
            assert_eq!(history_count(&conn), 1, "reabrir y cerrar no debe duplicar la sesión (session_id: {session_id:?})");

            let same_id: String = conn.query_row("SELECT id FROM session_history", [], |r| r.get(0)).unwrap();
            assert_eq!(same_id, hid, "debe ser la MISMA entrada, actualizada");
        }
    }

    /// Sin `history_id` ni `session_id` tampoco se acumulan copias: una tab del mismo
    /// agente en la misma carpeta es indistinguible de la anterior.
    #[test]
    fn sessions_without_any_id_do_not_pile_up() {
        let conn = setup();
        for i in 0..3 {
            let tab_id = format!("tab-{i}");
            insert_tab(&conn, &tab_id, None, None);
            archive_tab_row(&conn, &tab_id, "ws").unwrap();
            conn.execute("DELETE FROM tabs WHERE id = ?1", [&tab_id]).unwrap();
        }
        assert_eq!(history_count(&conn), 1);
    }

    /// Una sesión archivada sin id que resuelve uno al reabrirse queda identificada, sin
    /// dejar atrás la entrada vieja.
    #[test]
    fn discovered_session_id_is_written_back_to_the_existing_entry() {
        let conn = setup();
        insert_tab(&conn, "tab-1", None, None);
        archive_tab_row(&conn, "tab-1", "ws").unwrap();
        let hid: String = conn.query_row("SELECT id FROM session_history", [], |r| r.get(0)).unwrap();

        conn.execute("DELETE FROM tabs WHERE id = 'tab-1'", []).unwrap();
        insert_tab(&conn, "tab-2", Some("sess-descubierta"), Some(&hid));
        archive_tab_row(&conn, "tab-2", "ws").unwrap();

        assert_eq!(history_count(&conn), 1);
        let sid: Option<String> = conn
            .query_row("SELECT session_id FROM session_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sid.as_deref(), Some("sess-descubierta"));
    }

    /// Los duplicados que dejó la versión anterior se colapsan al arrancar, conservando
    /// el opened_at más viejo y los datos del cierre más reciente.
    #[test]
    fn existing_duplicates_are_collapsed_on_startup() {
        let conn = setup();
        for (i, (opened, closed, title)) in
            [(100, 200, "viejo"), (300, 400, "medio"), (500, 600, "nuevo")].iter().enumerate()
        {
            conn.execute(
                "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
                 VALUES (?1, 'ws', 'claude-code', 'Claude Code', 'claude', '/proj', ?2, NULL, '[]', ?3, ?4)",
                rusqlite::params![format!("h{i}"), title, opened, closed],
            ).unwrap();
        }
        // Otra sesión, distinta carpeta: no debe tocarse.
        conn.execute(
            "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
             VALUES ('otra', 'ws', 'claude-code', 'Claude Code', 'claude', '/otro', 'otra', NULL, '[]', 10, 20)",
            [],
        ).unwrap();

        dedupe_session_history(&conn).unwrap();

        assert_eq!(history_count(&conn), 2, "los 3 duplicados quedan en 1, la otra sesión intacta");
        let (title, opened, closed): (String, i64, i64) = conn
            .query_row(
                "SELECT title, opened_at, closed_at FROM session_history WHERE cwd = '/proj'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "nuevo", "sobrevive la del cierre más reciente");
        assert_eq!(opened, 100, "pero hereda cuándo empezó realmente la conversación");
        assert_eq!(closed, 600);
    }
}
