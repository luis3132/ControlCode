//! Consultas de ventanas y tabs: el estado de sesión que se guarda y se restaura.

use rusqlite::OptionalExtension;
use uuid::Uuid;

use crate::util::now_ts;
use crate::database::models::{
    row_to_tab, row_to_window, RestoredWindowState, WindowStatePayload,
};
use crate::database::DbConnection;

use std::collections::HashMap;

use super::sessions::{archive_tab_row, resolve_for_archive, ResolvedSession};

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

/// Resuelve, SIN el lock puesto, la sesión y el título de cada tab que este guardado va a
/// dar por cerrada.
///
/// Que la lista de tabs a cerrar se calcule acá y no dentro del guardado abre una ventana
/// mínima en la que una tab podría aparecer o desaparecer; el guardado vuelve a
/// calcularla con el lock tomado y usa esta tabla solo como cache. Una tab que llegue sin
/// resolver se archiva con lo que ya tenía guardado, que es exactamente el comportamiento
/// anterior a esta feature.
fn resolve_closing_tabs(state: &WindowStatePayload, db: &DbConnection) -> HashMap<String, ResolvedSession> {
    if !state.authoritative {
        return HashMap::new();
    }
    let incoming: std::collections::HashSet<&str> =
        state.tabs.iter().map(|t| t.id.as_str()).collect();

    let closing: Vec<String> = {
        let Ok(conn) = db.lock() else { return HashMap::new() };
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tabs t JOIN windows w ON w.id = t.window_id WHERE w.label = ?1",
        ) else {
            return HashMap::new();
        };
        let Ok(rows) = stmt.query_map([&state.label], |r| r.get::<_, String>(0)) else {
            return HashMap::new();
        };
        rows.filter_map(|r| r.ok()).filter(|id| !incoming.contains(id.as_str())).collect()
    };

    closing.into_iter().map(|id| {
        let resolved = resolve_for_archive(db, &id);
        (id, resolved)
    }).collect()
}

/// Genérica sobre el runtime para poder ejercitarla con el runtime de prueba de Tauri: es
/// la función que decide qué tabs se dan por cerradas, y eso necesita test.
pub(crate) fn db_save_window_state_sync<R: tauri::Runtime>(
    state: WindowStatePayload,
    db: &DbConnection,
    app: &tauri::AppHandle<R>,
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

    // Qué tabs se van a dar por cerradas, y con qué sesión/título archivarlas — todo esto
    // ANTES de tomar el lock: resolver la sesión lee disco y puede lanzar un proceso, y
    // hacerlo con el mutex tomado bloquea la base para toda la app (ver `ResolvedSession`).
    let resolved = resolve_closing_tabs(&state, db);

    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = now_ts();

    conn.execute(
        "INSERT INTO windows (id, label, workspace_id, pos_x, pos_y, width, height, monitor, is_open, last_active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
         ON CONFLICT(label) DO UPDATE SET
           pos_x = excluded.pos_x, pos_y = excluded.pos_y,
           width = excluded.width, height = excluded.height,
           monitor = excluded.monitor,
           -- Una ventana que está autosalvando ESTÁ abierta: llegar hasta acá ya probó que
           -- su ventana nativa existe (el early return de arriba). Antes `is_open` solo se
           -- escribía en el INSERT, así que una fila que quedaba en 0 con su ventana viva
           -- no se recuperaba nunca — y `desired_skills_for_link_dir` exige `is_open = 1`,
           -- con lo cual cada reconcile borraba los symlinks de esas tabs: las filas de
           -- `project_skills` intactas y ni una skill en disco.
           is_open = 1,
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
    // Solo una ventana que sabe lo que tiene puede afirmar que una tab se cerró: ver
    // `WindowStatePayload::authoritative`.
    let closed_ids: Vec<&String> = if state.authoritative {
        existing_ids.iter().filter(|id| !incoming_ids.contains(id.as_str())).collect()
    } else {
        Vec::new()
    };
    for closed_id in closed_ids {
        let resolved = resolved.get(closed_id.as_str()).cloned().unwrap_or_default();
        archive_tab_row(&conn, closed_id, &state.workspace_id, &resolved)?;
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
    // Antes del lock: si esta ventana pierde sus tabs, hay que resolverles la sesión, y eso
    // lee disco y puede lanzar procesos (ver `ResolvedSession`).
    let resolved = resolve_tabs_of_window(db, label);

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
            let r = resolved.get(tab_id.as_str()).cloned().unwrap_or_default();
            archive_tab_row(&conn, tab_id, &workspace_id, &r)?;
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

/// Igual que `resolve_closing_tabs`, para los cierres que se llevan una ventana entera.
fn resolve_tabs_of_window(db: &DbConnection, label: &str) -> HashMap<String, ResolvedSession> {
    let ids: Vec<String> = {
        let Ok(conn) = db.lock() else { return HashMap::new() };
        let Ok(mut stmt) = conn.prepare(
            "SELECT t.id FROM tabs t JOIN windows w ON w.id = t.window_id WHERE w.label = ?1",
        ) else {
            return HashMap::new();
        };
        let Ok(rows) = stmt.query_map([label], |r| r.get::<_, String>(0)) else {
            return HashMap::new();
        };
        rows.filter_map(|r| r.ok()).collect()
    };
    ids.into_iter().map(|id| {
        let resolved = resolve_for_archive(db, &id);
        (id, resolved)
    }).collect()
}
