//! Tests de la capa de base de datos.
//!
//! Todos corren contra el schema REAL (`schema::in_memory`), no contra una copia a mano:
//! una base de prueba que no tenga las mismas FK que la de producción no puede reproducir
//! los bugs de cascada, que son justo los que más caro salieron acá.

use rusqlite::Connection;
use uuid::Uuid;

use super::schema;
use super::*;

// ── Helpers ──────────────────────────────────────────────────────

/// Base con el schema real y un workspace `ws` con una ventana abierta `win`.
fn setup() -> Connection {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows (id, label, workspace_id, is_open, last_active)
             VALUES ('win', 'win', 'ws', 1, 0);",
    )
    .unwrap();
    conn
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn history_count(conn: &Connection) -> i64 {
    count(conn, "SELECT COUNT(*) FROM session_history")
}

fn insert_tab(conn: &Connection, id: &str, session_id: Option<&str>, history_id: Option<&str>) {
    conn.execute(
        "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, session_id, history_id, opened_at, created_at, last_active)
         VALUES (?1, 'win', 'Mi sesión', 'claude-code', 'Claude Code', 'claude', '/proj', ?2, ?3, 100, 0, 0)",
        rusqlite::params![id, session_id, history_id],
    )
    .unwrap();
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

// ── Guardado del estado de una ventana ───────────────────────────

/// Base con una ventana `main` (el label que usa `mock_app_with_main_window`) con dos
/// tabs, la segunda con una skill attacheada.
fn setup_window_save() -> Connection {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES ('w1', 'main', 'ws', 1, 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
            VALUES ('t1', 'w1', 'claude-code', 'Claude Code', 'claude', '/tmp/uno', 0, 0, 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
            VALUES ('t2', 'w1', 'claude-code', 'Claude Code', 'claude', '/tmp/dos', 0, 0, 0);
         INSERT INTO skills (id, name, source_path, installed_at, updated_at)
            VALUES ('sk', 'una-skill', '/tmp/skills/una-skill', 0, 0);
         INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
            VALUES ('ps', 'sk', 'ws', 'tab', 't2', 1, 0);",
    )
    .unwrap();
    conn
}

fn payload(tabs: Vec<&str>, authoritative: bool) -> WindowStatePayload {
    WindowStatePayload {
        label: "main".into(),
        workspace_id: "ws".into(),
        pos_x: None,
        pos_y: None,
        width: None,
        height: None,
        monitor: None,
        authoritative,
        tabs: tabs
            .into_iter()
            .map(|id| TabStatePayload {
                id: id.into(),
                title: String::new(),
                title_is_custom: false,
                agent_id: "claude-code".into(),
                agent_label: "Claude Code".into(),
                command: "claude".into(),
                cwd: format!("/tmp/{id}"),
                tab_order: 0,
                session_id: None,
                scrollback: None,
                history_id: None,
                account_id: None,
                prelaunch: Vec::new(),
                opened_at: 0,
            })
            .collect(),
    }
}

/// App de prueba CON una ventana `main` de verdad. Sin ella, `db_save_window_state_sync`
/// se va por su early return ("guardado de una ventana que ya no existe") y los tests
/// pasarían sin ejercitar nada.
fn mock_app_with_main_window() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("/".into()))
        .build()
        .expect("la ventana de prueba tiene que existir");
    app
}

/// EL bug intermitente: una ventana que todavía no cargó su estado (o que falló al
/// intentarlo) mandaba una lista de tabs incompleta, y el backend daba por cerradas las
/// que faltaban — borrándolas y llevándose por cascada sus skills.
///
/// Un payload no autoritativo tiene que poder guardar lo que trae SIN borrar nada.
#[test]
fn un_guardado_no_autoritativo_no_puede_borrar_tabs() {
    let db: DbConnection = std::sync::Arc::new(std::sync::Mutex::new(setup_window_save()));
    let app = mock_app_with_main_window();

    db_save_window_state_sync(payload(vec!["t1"], false), &db, app.handle()).unwrap();

    let conn = db.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tabs"), 2, "no se borra ninguna tab");
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM project_skills"),
        1,
        "la skill sigue attacheada"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM session_history"), 0, "no se archiva nada");
}

/// Y con el estado ya cargado sí manda: una tab ausente es una tab que el usuario cerró.
#[test]
fn un_guardado_autoritativo_si_cierra_las_tabs_que_faltan() {
    let db: DbConnection = std::sync::Arc::new(std::sync::Mutex::new(setup_window_save()));
    let app = mock_app_with_main_window();

    db_save_window_state_sync(payload(vec!["t1"], true), &db, app.handle()).unwrap();

    let conn = db.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tabs"), 1, "t2 se cerró");
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM session_history"),
        1,
        "y quedó archivada en el historial"
    );
    // Lo que importa del archivado: sus skills quedan guardadas, no perdidas.
    let skills: String =
        conn.query_row("SELECT skills FROM session_history", [], |r| r.get(0)).unwrap();
    assert!(skills.contains("una-skill"), "el historial guarda la skill: {skills}");
}

// ── Siembra de repositorios ──────────────────────────────────────

fn skillssh_count(conn: &Connection) -> i64 {
    count(conn, "SELECT COUNT(*) FROM registries WHERE source_type = 'skillssh'")
}

/// La fuente nueva tiene que aparecerle también a quien ya venía usando la app — o sea,
/// con la tabla de repositorios NO vacía, que es donde la siembra original no llega. Y
/// queda detrás de los que ya estaban: hasta que se busque algo no aporta nada.
#[test]
fn skills_sh_se_agrega_aunque_ya_hubiera_repositorios() {
    let conn = schema::in_memory();
    conn.execute(
        "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
         VALUES ('viejo', 'Uno', 'github', 'a/b', 0, 1, 0)",
        [],
    )
    .unwrap();

    seeds::ensure_skillssh_registry(&conn).unwrap();

    assert_eq!(skillssh_count(&conn), 1);
    let priority: i32 = conn
        .query_row("SELECT priority FROM registries WHERE source_type = 'skillssh'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(priority, 1);
}

/// Arrancar la app N veces no puede dejar N copias del mismo repositorio, y borrarlo es
/// una decisión del usuario: el próximo arranque tiene que respetarla.
#[test]
fn skills_sh_se_siembra_una_sola_vez_y_no_revive() {
    let conn = schema::in_memory();
    seeds::ensure_skillssh_registry(&conn).unwrap();
    seeds::ensure_skillssh_registry(&conn).unwrap();
    assert_eq!(skillssh_count(&conn), 1);

    conn.execute("DELETE FROM registries WHERE source_type = 'skillssh'", []).unwrap();
    seeds::ensure_skillssh_registry(&conn).unwrap();
    assert_eq!(skillssh_count(&conn), 0, "borrado por el usuario, no vuelve");
}

// ── Reabrir una sesión ya abierta ────────────────────────────────

/// Reanudar tiene que ENFOCAR la tab existente, no abrir otra — y eso tiene que valer
/// tanto para las sesiones con id resuelto como para las que solo tienen su entrada del
/// historial (esas se duplicaban en cada reapertura).
#[test]
fn una_sesion_ya_abierta_se_encuentra_por_su_id_o_por_su_historial() {
    let conn = setup();
    insert_tab(&conn, "t1", Some("sess-1"), None);
    assert_eq!(
        open_tab_for_session(&conn, Some("sess-1"), None, "ws").unwrap().unwrap().tab_id,
        "t1"
    );

    let conn = setup();
    insert_tab(&conn, "t1", None, Some("h1"));
    assert_eq!(open_tab_for_session(&conn, None, Some("h1"), "ws").unwrap().unwrap().tab_id, "t1");
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

// ── Archivado: a qué sesión pertenece de verdad la tab ───────────

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
/// de escribirlo. Con `summary` se escribe además la línea de la que saca el título.
fn write_transcript(
    profile: &std::path::Path,
    cwd: &str,
    session_id: &str,
    summary: Option<&str>,
) {
    let dir = profile.join("projects").join(cwd.replace('/', "-"));
    std::fs::create_dir_all(&dir).unwrap();
    let body = match summary {
        Some(s) => format!("{{\"type\":\"summary\",\"summary\":\"{s}\"}}\n"),
        None => "{}\n".to_string(),
    };
    std::fs::write(dir.join(format!("{session_id}.jsonl")), body).unwrap();
}

fn archived_session_id(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT session_id FROM session_history", [], |r| r.get(0)).unwrap()
}

/// Archiva como lo hace la app: la sesión se resuelve con el lock SUELTO (lee disco y
/// puede lanzar procesos) y recién después se escribe con el lock puesto.
fn archive(db: &DbConnection, tab_id: &str, ws: &str) {
    let resolved = resolve_for_archive(db, tab_id);
    let conn = db.lock().unwrap();
    archive_tab_row(&conn, tab_id, ws, &resolved).unwrap();
}

fn setup_db() -> DbConnection {
    std::sync::Arc::new(std::sync::Mutex::new(setup()))
}

/// El bug reportado: retomar una conversación DESDE ADENTRO de la TUI (`/resume`) dejaba
/// la tab con el id que se descubrió al arrancar, así que al cerrar se archivaba una
/// sesión nueva y la conversación continuada quedaba sin actualizar.
///
/// Y con la sesión cambiada, el título de la tab es el de la conversación abandonada:
/// escribirlo pisaría el título bueno de la que se retomó, así que se recalcula.
#[test]
fn archivar_sigue_a_la_sesion_retomada_dentro_de_la_tui() {
    let db = setup_db();
    let profile = TempDir::new();
    write_transcript(&profile.0, "/proj", "la-retomada", Some("Charla retomada"));
    insert_tab_with_account(&db.lock().unwrap(), "tab-1", Some("la-de-arranque"), &profile.0);

    archive(&db, "tab-1", "ws");

    let conn = db.lock().unwrap();
    assert_eq!(archived_session_id(&conn).as_deref(), Some("la-retomada"));
    let title: Option<String> =
        conn.query_row("SELECT title FROM session_history", [], |r| r.get(0)).unwrap();
    assert_eq!(title.as_deref(), Some("Charla retomada"));
}

/// Con dos tabs del mismo agente en la misma carpeta, el archivo más nuevo puede ser el
/// de la OTRA tab. Robárselo dejaría dos entradas del historial sobre la misma
/// conversación, que es peor que no reconciliar.
#[test]
fn la_reconciliacion_no_le_roba_la_sesion_a_otra_tab() {
    let db = setup_db();
    let profile = TempDir::new();
    write_transcript(&profile.0, "/proj", "de-la-otra-tab", None);
    {
        let conn = db.lock().unwrap();
        insert_tab_with_account(&conn, "tab-1", Some("la-mia"), &profile.0);
        insert_tab_with_account(&conn, "tab-2", Some("de-la-otra-tab"), &profile.0);
    }

    archive(&db, "tab-1", "ws");

    assert_eq!(archived_session_id(&db.lock().unwrap()).as_deref(), Some("la-mia"));
}

/// No encontrar nada significa "no sé", no "no tenía sesión": el id previo se conserva.
#[test]
fn la_reconciliacion_conserva_el_id_previo_si_no_encuentra_nada() {
    let db = setup_db();
    let profile = TempDir::new();
    insert_tab_with_account(&db.lock().unwrap(), "tab-1", Some("la-unica"), &profile.0);

    archive(&db, "tab-1", "ws");

    assert_eq!(archived_session_id(&db.lock().unwrap()).as_deref(), Some("la-unica"));
}

// ── Historial: una entrada por conversación ─────────────────────

/// El bug reportado: reabrir una sesión desde el historial y volver a cerrarla dejaba
/// DOS entradas de la misma sesión en vez de actualizar la que ya estaba.
#[test]
fn reabrir_y_cerrar_una_sesion_actualiza_su_entrada() {
    for session_id in [None, Some("sess-1")] {
        let db = setup_db();

        // Primer ciclo: la tab se abre y se cierra → una entrada.
        insert_tab(&db.lock().unwrap(), "tab-1", session_id, None);
        archive(&db, "tab-1", "ws");

        let (hid, opened_at): (String, i64) = {
            let conn = db.lock().unwrap();
            assert_eq!(history_count(&conn), 1, "el primer cierre crea una sola entrada");
            conn.query_row("SELECT id, opened_at FROM session_history", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(opened_at, 100);

        // Segundo ciclo: se reabre DESDE el historial (la tab nueva lleva history_id)
        // y se vuelve a cerrar. Debe seguir habiendo una sola entrada.
        {
            let conn = db.lock().unwrap();
            conn.execute("DELETE FROM tabs WHERE id = 'tab-1'", []).unwrap();
            insert_tab(&conn, "tab-2", session_id, Some(&hid));
        }
        archive(&db, "tab-2", "ws");

        let conn = db.lock().unwrap();
        assert_eq!(
            history_count(&conn),
            1,
            "reabrir y cerrar no debe duplicar la sesión (session_id: {session_id:?})"
        );
        let same_id: String =
            conn.query_row("SELECT id FROM session_history", [], |r| r.get(0)).unwrap();
        assert_eq!(same_id, hid, "debe ser la MISMA entrada, actualizada");
    }
}

/// Sin `history_id` ni `session_id` tampoco se acumulan copias: una tab del mismo
/// agente en la misma carpeta es indistinguible de la anterior.
#[test]
fn las_sesiones_sin_ningun_id_no_se_acumulan() {
    let db = setup_db();
    for i in 0..3 {
        let tab_id = format!("tab-{i}");
        insert_tab(&db.lock().unwrap(), &tab_id, None, None);
        archive(&db, &tab_id, "ws");
        db.lock().unwrap().execute("DELETE FROM tabs WHERE id = ?1", [&tab_id]).unwrap();
    }
    assert_eq!(history_count(&db.lock().unwrap()), 1);
}

/// Una sesión archivada sin id que resuelve uno al reabrirse queda identificada, sin
/// dejar atrás la entrada vieja.
#[test]
fn el_id_de_sesion_descubierto_se_escribe_en_la_entrada_existente() {
    let db = setup_db();
    insert_tab(&db.lock().unwrap(), "tab-1", None, None);
    archive(&db, "tab-1", "ws");
    let hid: String =
        db.lock().unwrap().query_row("SELECT id FROM session_history", [], |r| r.get(0)).unwrap();

    {
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM tabs WHERE id = 'tab-1'", []).unwrap();
        insert_tab(&conn, "tab-2", Some("sess-descubierta"), Some(&hid));
    }
    archive(&db, "tab-2", "ws");

    let conn = db.lock().unwrap();
    assert_eq!(history_count(&conn), 1);
    let sid: Option<String> =
        conn.query_row("SELECT session_id FROM session_history", [], |r| r.get(0)).unwrap();
    assert_eq!(sid.as_deref(), Some("sess-descubierta"));
}

/// Los duplicados que dejó la versión anterior se colapsan al arrancar, conservando
/// el opened_at más viejo y los datos del cierre más reciente.
#[test]
fn los_duplicados_viejos_se_colapsan_al_arrancar() {
    let conn = setup();
    for (i, (opened, closed, title)) in
        [(100, 200, "viejo"), (300, 400, "medio"), (500, 600, "nuevo")].iter().enumerate()
    {
        conn.execute(
            "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
             VALUES (?1, 'ws', 'claude-code', 'Claude Code', 'claude', '/proj', ?2, NULL, '[]', ?3, ?4)",
            rusqlite::params![format!("h{i}"), title, opened, closed],
        )
        .unwrap();
    }
    // Otra sesión, distinta carpeta: no debe tocarse.
    conn.execute(
        "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
         VALUES ('otra', 'ws', 'claude-code', 'Claude Code', 'claude', '/otro', 'otra', NULL, '[]', 10, 20)",
        [],
    )
    .unwrap();

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

// ── Guardar un workspace se lleva sus skills ─────────────────────

fn attach_skill_row(conn: &Connection, id: &str, ws: &str, scope: &str, tab: Option<&str>) {
    conn.execute(
        "INSERT INTO skills (id, name, source_path, installed_at, updated_at)
         VALUES ('skill-1', 'una', '/tmp/una', 0, 0) ON CONFLICT(id) DO NOTHING",
        [],
    )
    .unwrap();
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
fn guardar_un_workspace_se_lleva_sus_skills() {
    let conn = setup();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('nuevo', 'Nuevo', 0, 0)",
        [],
    )
    .unwrap();
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
fn los_attachments_de_lo_que_se_quedo_no_se_mueven() {
    let conn = setup();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('nuevo', 'Nuevo', 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO windows (id, label, workspace_id, is_open, last_active)
         VALUES ('win-cerrada', 'win-cerrada', 'ws', 0, 0)",
        [],
    )
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
fn los_labels_de_ventana_generados_no_colisionan() {
    let labels: std::collections::HashSet<String> =
        (0..500).map(|_| fresh_window_label()).collect();
    assert_eq!(labels.len(), 500);
}

// ── Migraciones ──────────────────────────────────────────────────

/// Una base ya al día no tiene nada que migrar, y queda estampada con su versión: lo que
/// evita volver a adivinar (y a decidir mal) en el próximo arranque.
#[test]
fn una_base_nueva_queda_estampada_con_su_version() {
    let conn = schema::in_memory();
    let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert!(v > 0, "la base tiene que quedar con su versión de schema");

    // Volver a migrar es un no-op.
    schema::migrate(&conn).unwrap();
    let v2: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, v2);
}

/// El bug que importaba: a una base sin `tabs.opened_at` la versión anterior le hacía
/// `DROP TABLE tabs`, o sea que actualizar la app te borraba todas las tabs guardadas.
/// Ahora se agrega la columna y las filas sobreviven.
#[test]
fn migrar_una_base_vieja_no_le_borra_las_tabs() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
         CREATE TABLE windows (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 1, last_active INTEGER NOT NULL);
         CREATE TABLE tabs (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, title TEXT, title_is_custom INTEGER NOT NULL DEFAULT 0, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, tab_order INTEGER NOT NULL DEFAULT 0, session_id TEXT, scrollback TEXT, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
         INSERT INTO workspaces VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows VALUES ('w', 'w', 'ws', 1, 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd, created_at, last_active)
            VALUES ('t1', 'w', 'claude-code', 'Claude Code', 'claude', '/proj', 0, 0);",
    )
    .unwrap();

    schema::migrate(&conn).unwrap();

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tabs"), 1, "la tab guardada sobrevive");
    assert_eq!(count(&conn, "SELECT opened_at FROM tabs WHERE id = 't1'"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 1);
}

/// El modelo pre-v3 no tiene traducción fila a fila, pero tampoco se borra: se aparta con
/// otro nombre, así un error de detección cuesta una tabla huérfana y no los datos.
#[test]
fn el_modelo_viejo_se_aparta_en_vez_de_borrarse() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, root_path TEXT NOT NULL);
         INSERT INTO workspaces VALUES ('ws', '/proj');",
    )
    .unwrap();

    schema::migrate(&conn).unwrap();

    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM workspaces_legacy_v2"),
        1,
        "los datos viejos siguen ahí"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 0, "y la tabla nueva arranca vacía");
}

// ── Migraciones sobre una base que ya existía ────────────────────
//
// `schema::in_memory()` crea todo de cero, así que no puede ver los errores que solo
// aparecen cuando la tabla YA está: un `CREATE TABLE IF NOT EXISTS` es un no-op ahí, y
// todo lo que dependa de una columna nueva tiene que venir de un ALTER antes.

/// Una base con la forma de la v8: `project_skills` sin la columna `cwd`.
fn base_v8() -> Connection {
    let conn = Connection::open_in_memory().expect("base en memoria");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA user_version = 8;
         CREATE TABLE workspaces (
             id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
             created_at INTEGER NOT NULL, last_active INTEGER NOT NULL
         );
         CREATE TABLE windows (
             id TEXT PRIMARY KEY, label TEXT NOT NULL,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             is_open INTEGER NOT NULL DEFAULT 1, last_active INTEGER NOT NULL
         );
         CREATE TABLE tabs (
             id TEXT PRIMARY KEY,
             window_id TEXT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
             title TEXT, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL,
             command TEXT NOT NULL, cwd TEXT NOT NULL,
             opened_at INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL, last_active INTEGER NOT NULL
         );
         CREATE TABLE skills (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, source_path TEXT NOT NULL
         );
         CREATE TABLE project_skills (
             id           TEXT PRIMARY KEY,
             skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             scope        TEXT NOT NULL DEFAULT 'workspace',
             tab_id       TEXT REFERENCES tabs(id) ON DELETE CASCADE,
             enabled      INTEGER NOT NULL DEFAULT 1,
             created_at   INTEGER NOT NULL,
             UNIQUE (skill_id, workspace_id, scope, tab_id)
         );
         INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO skills (id, name, source_path) VALUES ('sk', 'una', '/tmp/una');",
    )
    .expect("base v8");
    conn
}

/// El bug que tiró la app al arrancar: la migración corría los índices sobre `cwd` antes
/// del ALTER que la agrega, y sobre una base existente eso es `no such column: cwd`.
#[test]
fn migrar_una_base_v8_no_explota() {
    let conn = base_v8();
    schema::migrate(&conn).expect("migrar de v8 a v9");

    let tiene_cwd: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('project_skills') WHERE name = 'cwd'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tiene_cwd, 1, "la columna cwd debería existir tras migrar");

    let indices: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
             AND name IN ('idx_project_skills_ws_cwd', 'idx_project_skills_tab')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(indices, 2, "los dos índices parciales deberían quedar creados");
}

/// Las filas que ya existían significaban "todas las carpetas del workspace", y eso es
/// exactamente lo que guarda la cadena vacía. Actualizar no debe cambiarles el alcance.
#[test]
fn las_filas_v8_conservan_su_alcance() {
    let conn = base_v8();
    conn.execute(
        "INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
         VALUES ('ps1', 'sk', 'ws', 'workspace', NULL, 1, 0)",
        [],
    )
    .unwrap();

    schema::migrate(&conn).expect("migrar");

    let cwd: String = conn
        .query_row("SELECT cwd FROM project_skills WHERE id = 'ps1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cwd, "", "una fila vieja tiene que seguir valiendo para todas las carpetas");
}

/// Hasta la v8 el upsert de scope='workspace' nunca encontraba conflicto (la UNIQUE
/// incluye `tab_id`, que ahí es NULL, y SQLite considera distintos a dos NULL), así que
/// re-attachear dejaba filas repetidas. El índice único nuevo no se puede crear sobre
/// ellas: la migración tiene que barrerlas primero.
#[test]
fn migrar_deduplica_las_filas_repetidas_de_la_v8() {
    let conn = base_v8();
    for id in ["ps1", "ps2", "ps3"] {
        conn.execute(
            "INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
             VALUES (?1, 'sk', 'ws', 'workspace', NULL, 1, 0)",
            [id],
        )
        .expect("la v8 dejaba meter duplicados");
    }

    schema::migrate(&conn).expect("migrar con duplicados");

    let filas: i64 = conn
        .query_row("SELECT COUNT(*) FROM project_skills", [], |r| r.get(0))
        .unwrap();
    assert_eq!(filas, 1, "quedaron {filas} filas; la migración debería dejar una");
}

/// Migrar dos veces seguidas no puede fallar: la app corre `migrate` en cada arranque.
#[test]
fn migrar_es_idempotente() {
    let conn = base_v8();
    schema::migrate(&conn).expect("primera migración");
    schema::migrate(&conn).expect("segunda migración sobre la ya migrada");
}

/// Un bucle de arranques fallidos deja una fila de ventana por intento, todas cerradas y
/// sin tabs. No rompen nada (nadie las restaura), pero se acumulan para siempre.
#[test]
fn se_barren_las_ventanas_cerradas_y_vacias() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO windows (id, label, workspace_id, is_open, last_active)
             VALUES ('muerta-1', 'w1', 'ws', 0, 0), ('muerta-2', 'w2', 'ws', 0, 0);",
    )
    .unwrap();

    let borradas = queries::purge_empty_closed_windows(&conn).unwrap();
    assert_eq!(borradas, 2);

    let quedan: i64 = conn
        .query_row("SELECT COUNT(*) FROM windows", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quedan, 1, "la ventana abierta del setup tiene que seguir ahí");
}

/// Lo único que no se puede tirar: una ventana cerrada que todavía guarda sus tabs, que es
/// justo la que hay que poder restaurar al reabrir el workspace.
#[test]
fn no_se_barre_una_ventana_cerrada_que_conserva_sus_tabs() {
    let conn = setup();
    conn.execute_batch(
        "INSERT INTO windows (id, label, workspace_id, is_open, last_active)
             VALUES ('cerrada', 'w1', 'ws', 0, 0);
         INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd,
                           opened_at, created_at, last_active)
             VALUES ('t1', 'cerrada', 'Una', 'claude-code', 'Claude Code', 'claude', '/p', 0, 0, 0);",
    )
    .unwrap();

    assert_eq!(queries::purge_empty_closed_windows(&conn).unwrap(), 0);
    let quedan: i64 = conn
        .query_row("SELECT COUNT(*) FROM windows WHERE id = 'cerrada'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quedan, 1);
}

/// v10 sobre una base que ya existía: la tabla de workspaces cerrados es nueva y se crea
/// con el batch, pero el que se equivocó una vez con el orden de las migraciones conviene
/// que lo compruebe siempre.
#[test]
fn migrar_una_base_v8_crea_la_tabla_de_workspaces_cerrados() {
    let conn = base_v8();
    schema::migrate(&conn).expect("migrar");

    let existe: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshots'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(existe, 1);
}

/// Un workspace cerrado tiene que sobrevivir al reseteo del bucket `default`, que es donde
/// vive casi todo: por eso no lleva FK hacia `workspaces`.
#[test]
fn un_workspace_cerrado_sobrevive_a_que_borren_su_workspace() {
    let conn = setup();
    conn.execute(
        "INSERT INTO workspace_snapshots (cwd, workspace_id, tabs_json, closed_at)
         VALUES ('/p', 'ws', '[]', 0)",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM workspaces WHERE id = 'ws'", []).unwrap();

    let quedan: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quedan, 1, "el recuerdo no puede irse con el workspace");
}

/// Una base ya migrada, a la que se le vuelve a estampar una versión anterior para simular
/// la instalación de un usuario que actualiza. Es más fiel que escribir el DDL viejo a
/// mano: las tablas son exactamente las que la app venía creando.
fn base_v10_poblada() -> Connection {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO windows (id, label, workspace_id, last_active) VALUES ('wi', 'main', 'ws', 0);
         INSERT INTO tabs (id, window_id, agent_id, agent_label, command, cwd,
                           opened_at, created_at, last_active)
             VALUES ('t1', 'wi', 'claude-code', 'Claude Code', 'claude', '/tmp/p', 0, 0, 0);
         INSERT INTO skills (id, name, source_path, installed_at, updated_at)
             VALUES ('sk', 'una', '/tmp/una', 0, 0);
         INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, created_at)
             VALUES ('ps', 'sk', 'ws', 'tab', 't1', 0);
         INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd,
                                      opened_at, closed_at)
             VALUES ('h1', 'ws', 'codex', 'Codex', 'codex', '/tmp/p', 0, 0);
         PRAGMA user_version = 10;",
    )
    .expect("base v10 poblada");
    conn
}

/// Actualizar la app no puede costarle al usuario una sola tab, sesión ni skill. Es lo
/// único que una migración no tiene permitido romper.
#[test]
fn migrar_de_v10_a_v11_no_pierde_nada_del_usuario() {
    let conn = base_v10_poblada();
    schema::migrate(&conn).expect("migrar de v10 a v11");

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tabs"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM skills"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM project_skills"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM session_history"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM workspaces"), 1);

    // Y las tablas nuevas quedaron creadas y vacías.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM runs"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 0);
}

/// Las tareas headless cuelgan de su run, y el run de su workspace: olvidar un workspace
/// no puede dejar filas de tareas apuntando a la nada.
#[test]
fn borrar_un_workspace_se_lleva_sus_runs_y_tareas() {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at)
             VALUES ('r', 'ws', 'obj', '/tmp/p', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, cwd, created_at)
             VALUES ('t', 'r', 'tit', 'pr', 'claude-code', '/tmp/p', 0);",
    )
    .unwrap();

    conn.execute("DELETE FROM workspaces WHERE id = 'ws'", []).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM runs"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 0);
}

/// La v14 le agrega a `tasks` las columnas del worktree. Sobre una base que ya tenía tareas
/// (desde la v11), las filas existentes tienen que quedar intactas y sin worktree.
#[test]
fn migrar_a_v14_agrega_el_worktree_sin_tocar_las_tareas() {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at) VALUES ('r', 'ws', 'o', '/p', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, cwd, created_at)
             VALUES ('t', 'r', 'tit', 'pr', 'claude-code', '/p', 0);
         PRAGMA user_version = 13;",
    )
    .unwrap();

    schema::migrate(&conn).expect("migrar de v13 a v14");

    let (wt, removed): (Option<String>, i64) = conn
        .query_row("SELECT worktree_path, worktree_removed FROM tasks WHERE id = 't'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((wt, removed), (None, 0));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM tasks"), 1);
}

/// La v15 le agrega a `tasks` con qué criterio se asignó. Las columnas se BORRAN antes de
/// migrar (SQLite lo permite desde la 3.35) para que el `ALTER` corra de verdad: con la
/// base recién creada ya estarían, y el test pasaría sin probar nada.
#[test]
fn migrar_a_v15_agrega_el_ruteo_sin_tocar_las_tareas() {
    let conn = schema::in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws', 'WS', 0, 0);
         INSERT INTO runs (id, workspace_id, objective, cwd, created_at) VALUES ('r', 'ws', 'o', '/p', 0);
         INSERT INTO tasks (id, run_id, title, prompt, agent_id, model, cwd, created_at)
             VALUES ('t', 'r', 'tit', 'pr', 'claude-code', 'opus', '/p', 0);
         ALTER TABLE tasks DROP COLUMN complexity;
         ALTER TABLE tasks DROP COLUMN routed_by;
         ALTER TABLE tasks DROP COLUMN route_note;
         PRAGMA user_version = 14;",
    )
    .unwrap();

    schema::migrate(&conn).expect("migrar de v14 a v15");

    let (model, complexity, routed_by, note): (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row("SELECT model, complexity, routed_by, route_note FROM tasks WHERE id = 't'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!(model, "opus", "la tarea que ya estaba sigue igual");
    assert_eq!((complexity, routed_by, note), (None, None, None));
}
