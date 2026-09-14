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
const SCHEMA_VERSION: i32 = 15;

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

    // Va ACÁ y no más abajo a propósito: el batch de más adelante crea un índice único
    // sobre `cwd`, y sobre una base que ya existe el `CREATE TABLE IF NOT EXISTS` de esa
    // tabla es un no-op — sin la columna puesta primero, ese índice falla y la app no
    // arranca. En una base nueva no se nota, porque ahí la tabla nace con la columna.
    //
    // v9 — las skills de scope='workspace' pasan a ser POR CARPETA.
    //
    // Antes valían para todas las tabs del workspace, o sea que activar una skill en un
    // proyecto la metía también en los otros que tuvieras abiertos en la misma ventana.
    // Con "cada carpeta es un workspace" eso deja de tener sentido. Las filas que ya
    // existían quedan con `''` = "todas las carpetas", que es exactamente lo que
    // significaban, así que nadie pierde una skill al actualizar.
    if table_exists(conn, "project_skills") && !has_column(conn, "project_skills", "cwd") {
        conn.execute("ALTER TABLE project_skills ADD COLUMN cwd TEXT NOT NULL DEFAULT ''", [])?;

        // Los índices únicos nuevos no se pueden crear sobre filas repetidas, y repetidas
        // puede haber: hasta acá el upsert de scope='workspace' nunca encontraba conflicto
        // (ver el comentario del schema), así que cada re-attach dejaba una fila más.
        // Se conserva la más vieja de cada grupo.
        conn.execute(
            "DELETE FROM project_skills WHERE rowid NOT IN (
                 SELECT MIN(rowid) FROM project_skills
                 GROUP BY skill_id, workspace_id, scope, IFNULL(tab_id, ''), cwd
             )",
            [],
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
             -- Con scope='workspace': la CARPETA a la que aplica. Un workspace es una
             -- copia de trabajo, y sus skills valen ahí y no en las otras carpetas que
             -- estén abiertas en la misma ventana. La cadena vacía significa \"todas\",
             -- que es lo único que existía antes de la v9.
             cwd          TEXT NOT NULL DEFAULT '',
             UNIQUE (skill_id, workspace_id, scope, tab_id)
         );
         CREATE INDEX IF NOT EXISTS idx_project_skills_workspace ON project_skills(workspace_id);
         CREATE INDEX IF NOT EXISTS idx_project_skills_skill ON project_skills(skill_id);

         -- La UNIQUE de arriba no alcanza y no se puede cambiar sin recrear la tabla: con
         -- scope='workspace' el `tab_id` es NULL, y SQLite considera distintos a dos NULL,
         -- así que nunca dispara — attachear dos veces la misma skill dejaba dos filas y
         -- el ON CONFLICT del upsert no se activaba jamás. Estos índices parciales no
         -- tienen NULLs en sus columnas, así que sí garantizan una fila por caso.
         CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skills_ws_cwd
             ON project_skills(skill_id, workspace_id, cwd) WHERE scope = 'workspace';
         CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skills_tab
             ON project_skills(skill_id, tab_id) WHERE scope = 'tab';

         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );

         -- v10 — Workspaces cerrados a mano, para poder volver a abrirlos.
         --
         -- Sin esto, cerrar todas las tabs de una carpeta hacía desaparecer al workspace
         -- del panel: se deriva de las tabs abiertas, así que sin ninguna no queda nada
         -- que mostrar ni a qué volver.
         --
         -- La clave es el `cwd` y no un id: un workspace ES una carpeta, y al reabrirlo
         -- hay que encontrarlo por la carpeta que el usuario vuelve a elegir. Las tabs se
         -- guardan desnormalizadas como JSON por el mismo motivo que en `session_history`:
         -- las filas de `tabs` se borran al cerrarlas y se llevarían el recuerdo puesto.
         --
         -- No hay FK hacia `workspaces`: un snapshot tiene que sobrevivir al reseteo del
         -- bucket `default`, que es justo donde vive casi todo.
         CREATE TABLE IF NOT EXISTS workspace_snapshots (
             cwd          TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL,
             tabs_json    TEXT NOT NULL,
             closed_at    INTEGER NOT NULL
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
         );

         -- v11 — Agentes headless: los que corren sin terminal y sin que nadie los mire.
         --
         -- Son OTRA COSA que las tabs, aunque lancen la misma TUI. Una tab es un PTY que
         -- el usuario mira y tipea, y su fuente de verdad mientras la app corre es el
         -- store del frontend (SQLite es su reflejo con debounce). Una tarea headless es
         -- un proceso con el stdout redirigido del que la app es dueña de punta a punta,
         -- así que acá SQLite sí es la fuente de verdad: sobrevive a cerrar la ventana y
         -- es lo que la consola de flota lee.
         CREATE TABLE IF NOT EXISTS runs (
             id           TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             objective    TEXT NOT NULL,
             cwd          TEXT NOT NULL,
             -- running | done | failed | cancelled
             status       TEXT NOT NULL DEFAULT 'running',
             max_parallel INTEGER NOT NULL DEFAULT 2,
             budget_usd   REAL,
             spent_usd    REAL NOT NULL DEFAULT 0,
             created_at   INTEGER NOT NULL,
             ended_at     INTEGER
         );

         -- Una fila = una tarjeta de la consola.
         CREATE TABLE IF NOT EXISTS tasks (
             id         TEXT PRIMARY KEY,
             run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
             title      TEXT NOT NULL,
             prompt     TEXT NOT NULL,
             agent_id   TEXT NOT NULL,
             account_id TEXT,
             model      TEXT,
             cwd        TEXT NOT NULL,
             budget_usd REAL,
             -- ready | running | done | failed | cancelled
             status     TEXT NOT NULL DEFAULT 'ready',
             -- Lo fija la app ANTES de lanzar (--session-id), así que la fila y la sesión
             -- de la TUI quedan atadas desde el principio. Es lo que después permite
             -- reabrir la tarea como tab con --resume sin tener que descubrir nada.
             session_id TEXT,
             attempt    INTEGER NOT NULL DEFAULT 0,
             result     TEXT,
             error      TEXT,
             cost_usd   REAL,
             tokens_in  INTEGER,
             tokens_out INTEGER,
             -- El NDJSON crudo que escupió la TUI. El detalle vive en ese archivo y no en
             -- la base: son miles de eventos por tarea que nadie consulta dos veces, y
             -- meterlos acá sería inflar `data.db` con ruido.
             events_path TEXT,
             started_at INTEGER,
             ended_at   INTEGER,
             created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
         CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

         -- v12 — Cada permiso que un agente headless pidió, y qué se le contestó.
         --
         -- Se persiste y no vive solo en memoria por dos motivos. Es el registro de qué le
         -- autorizaste a quién, que es lo que uno quiere poder mirar después de dejar
         -- agentes corriendo solos. Y es de donde salen las reglas: una decisión que se
         -- repite es una que conviene dejar de preguntar.
         CREATE TABLE IF NOT EXISTS task_approvals (
             id         TEXT PRIMARY KEY,
             task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
             tool_name  TEXT NOT NULL,
             -- El `input` crudo de la herramienta. De acá sale el diff que se muestra.
             input_json TEXT NOT NULL,
             -- pending | allowed | denied
             status     TEXT NOT NULL DEFAULT 'pending',
             -- user | rule: si lo decidió una persona o una regla del run.
             decided_by TEXT,
             reason     TEXT,
             asked_at   INTEGER NOT NULL,
             decided_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_task_approvals_task ON task_approvals(task_id);

         -- v13 — Lo que se decide sin preguntar, por carpeta de proyecto.
         --
         -- Van por carpeta y no por run porque hoy cada lanzamiento abre su propio run: una
         -- regla del run duraba lo que dura UNA tarea, y un 'permitir siempre' que se olvida
         -- al lanzar el agente siguiente no es 'siempre'. La carpeta es la del run (el
         -- proyecto desde el que se lanzó), no la de la tarea: cuando las tareas corran en
         -- worktrees, cada una va a tener su propio cwd, y la política tiene que seguir
         -- siendo la del proyecto.
         CREATE TABLE IF NOT EXISTS permission_rules (
             id         TEXT PRIMARY KEY,
             cwd        TEXT NOT NULL,
             -- `Bash(git status*)`, `Read`, `Edit(src/**)`. La sintaxis de `--allowedTools`.
             pattern    TEXT NOT NULL,
             allow      INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             -- Una decisión nueva sobre el mismo patrón REEMPLAZA a la anterior: dos reglas
             -- idénticas con veredictos opuestos harían depender el resultado del orden.
             UNIQUE (cwd, pattern)
         );
         CREATE INDEX IF NOT EXISTS idx_permission_rules_cwd ON permission_rules(cwd);",
    )?;

    // v14 — El worktree de una tarea headless.
    //
    // Con ALTER porque `tasks` ya existe desde la v11. `cwd` de la tarea pasa a ser la del
    // worktree cuando lo hay; la del proyecto sigue en `runs.cwd`, que es de donde salen
    // las reglas. `worktree_removed` no borra las otras dos: la rama sigue existiendo (y
    // puede tener el trabajo del agente) aunque la carpeta ya no.
    if !has_column(conn, "tasks", "worktree_path") {
        conn.execute("ALTER TABLE tasks ADD COLUMN worktree_path TEXT", [])?;
        conn.execute("ALTER TABLE tasks ADD COLUMN branch TEXT", [])?;
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN worktree_removed INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // v15 — Con qué criterio se asignó cada tarea.
    //
    // `complexity` es lo que se declaró al lanzarla; `routed_by` si el modelo lo nombró
    // alguien (`manual`), salió a la primera del tramo (`policy`) o hubo que descartar algo
    // (`fallback`); y `route_note` qué se descartó y por qué. Es el dato para ajustar los
    // tramos a mano después: sin él no hay forma de saber si "trivial" está cayendo en un
    // modelo que después falla. Las tareas de antes quedan en NULL: se lanzaron a mano.
    if !has_column(conn, "tasks", "complexity") {
        conn.execute("ALTER TABLE tasks ADD COLUMN complexity TEXT", [])?;
        conn.execute("ALTER TABLE tasks ADD COLUMN routed_by TEXT", [])?;
        conn.execute("ALTER TABLE tasks ADD COLUMN route_note TEXT", [])?;
    }

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
