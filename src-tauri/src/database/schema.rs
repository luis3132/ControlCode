//! Schema de la base y sus migraciones.
//!
//! Todo lo que define CÓMO son las tablas vive acá: el DDL, los saltos de versión y los
//! `ALTER` de las columnas que se agregaron después. La conexión en sí la abre
//! `connection`; las consultas viven en `queries`.
//!
//! La versión del schema vive en `PRAGMA user_version`: cada migración se aplica una vez
//! y queda registrada. Antes se deducía en cada arranque probando qué columnas existían, y
//! la rama de "esto es viejo" borraba tablas enteras.
//!
//! Los tests construyen su base con [`in_memory`], que corre exactamente esta misma
//! migración — antes cada módulo mantenía a mano su propia copia del schema y esas copias
//! se desincronizaban del real sin que nada lo avisara.

use rusqlite::{Connection, Result as SqlResult};

/// Versión de schema que espera ESTA build. Se guarda en `PRAGMA user_version`, así que
/// la base sabe sola en qué versión está en vez de deducirlo probando columnas.
const SCHEMA_VERSION: i32 = 8;

fn user_version(conn: &Connection) -> SqlResult<i32> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn set_user_version(conn: &Connection, v: i32) -> SqlResult<()> {
    // `PRAGMA` no acepta parámetros, y `v` es una constante nuestra, no entrada de nadie.
    conn.execute_batch(&format!("PRAGMA user_version = {v};"))
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT {column} FROM {table} LIMIT 1")).is_ok()
}

/// En qué versión está una base que todavía no tiene `user_version` (todas las creadas
/// antes de que existiera este mecanismo).
///
/// Se deduce UNA sola vez, probando por qué columnas tiene; a partir de ahí queda
/// estampada y nunca más se adivina. Antes esta detección corría en CADA arranque y su
/// rama de "schema viejo" hacía `DROP TABLE workspaces/windows/tabs`: bastaba con que una
/// de esas pruebas se evaluara mal para borrarle los workspaces al usuario sin aviso.
fn detect_legacy_version(conn: &Connection) -> i32 {
    // Base recién creada: no hay nada que migrar, solo que crear.
    if !table_exists(conn, "workspaces") {
        return SCHEMA_VERSION;
    }
    // Modelo viejo de "carpeta raíz": workspaces indexado por `root_path` y tabs colgando
    // directo del workspace, sin ventanas de por medio.
    if has_column(conn, "workspaces", "root_path") || has_column(conn, "tabs", "workspace_id") {
        return 2;
    }
    // Scaffolding previo a la Fase 5 de skills.
    if table_exists(conn, "skills") && !has_column(conn, "skills", "source_path") {
        return 3;
    }
    if table_exists(conn, "tabs") && !has_column(conn, "tabs", "opened_at") {
        return 5;
    }
    SCHEMA_VERSION
}

/// Deja la base con el schema actual.
///
/// Es idempotente y va siempre hacia adelante: cada paso se aplica solo si la versión
/// guardada es anterior, y al final la base queda estampada con [`SCHEMA_VERSION`].
/// **Ningún paso borra datos del usuario**: lo que no se puede migrar se aparta con un
/// nombre `_legacy_*`, para que un error de detección cueste una tabla huérfana y no los
/// workspaces de alguien.
pub(crate) fn migrate(conn: &Connection) -> SqlResult<()> {
    let mut version = user_version(conn)?;
    if version == 0 {
        version = detect_legacy_version(conn);
    }

    if version < 3 {
        // El modelo cambió tanto (workspaces por carpeta → workspaces como layout de
        // ventanas) que no hay traducción posible fila a fila. Se aparta en vez de
        // borrarse: la app arranca limpia y los datos viejos siguen ahí para quien los
        // quiera mirar.
        for table in ["tabs", "windows", "workspaces"] {
            if table_exists(conn, table) {
                conn.execute_batch(&format!(
                    "DROP TABLE IF EXISTS {table}_legacy_v2;
                     ALTER TABLE {table} RENAME TO {table}_legacy_v2;"
                ))?;
            }
        }
    }

    if version < 4 {
        // Estas dos SÍ se borran: eran scaffolding sin usar de antes de la Fase 5 —
        // nunca tuvieron una fila real, y conservarlas obligaría a arrastrar un esquema
        // incompatible para siempre.
        conn.execute_batch("DROP TABLE IF EXISTS project_skills; DROP TABLE IF EXISTS skills;")?;
    }

    if version < 6 && table_exists(conn, "tabs") && !has_column(conn, "tabs", "opened_at") {
        // Antes esto recreaba `tabs` desde cero, o sea que actualizar la app te borraba
        // todas las tabs guardadas. La columna se puede agregar sin más: las filas que ya
        // existían no saben cuándo se abrieron, y 0 es exactamente eso.
        conn.execute("ALTER TABLE tabs ADD COLUMN opened_at INTEGER NOT NULL DEFAULT 0", [])?;
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

    // De qué ENTRADA del repositorio salió cada skill instalada.
    //
    // Hasta acá solo se guardaba el repo, y la unicidad se decidía por nombre. No alcanza:
    // dos skills pueden llamarse igual y ser de autores distintos, con contenido distinto —
    // y en skills.sh eso pasa dentro de un MISMO repositorio, porque su directorio lista
    // skills de muchos publicadores. Con el repo más esta columna la identidad es exacta:
    // para skills.sh el id de la entrada es `owner/repo/slug`, o sea que ya lleva el autor
    // adentro; para un repo de GitHub es la ruta de la carpeta, única por construcción.
    //
    // Las filas que ya existían quedan en NULL y las vincula `link_orphan_installs` cuando
    // el repositorio tenga cache, y solo si la coincidencia es inequívoca.
    if !has_column(conn, "skills", "origin_skill_id") {
        conn.execute("ALTER TABLE skills ADD COLUMN origin_skill_id TEXT", [])?;
    }

    set_user_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// Base en memoria con el schema REAL, para los tests. Vive en el código de producción a
/// propósito: es lo que garantiza que los tests corran contra el mismo schema que la app,
/// incluidas las FK (sin `PRAGMA foreign_keys = ON` los `ON DELETE CASCADE` son un no-op y
/// media clase de bugs de skills deja de poder reproducirse).
#[cfg(test)]
pub(crate) fn in_memory() -> Connection {
    let conn = Connection::open_in_memory().expect("base en memoria");
    conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
    migrate(&conn).expect("migración del schema de prueba");
    conn
}
