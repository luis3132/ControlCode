//! Consultas de workspaces: la configuración nombrada y persistida de ventanas + tabs
//! (no una carpeta raíz). Se crea explícitamente con "Guardar como workspace...".

use rusqlite::Connection;
use uuid::Uuid;

use crate::util::now_ts;
use crate::database::models::{
    row_to_window, WindowRow, Workspace, WorkspaceSummary, DEFAULT_WORKSPACE_ID,
};
use crate::database::DbConnection;

use super::sessions::{archive_tab_row, resolve_for_archive};

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
    // Antes del lock: resolver la sesión de cada tab lee disco y puede lanzar procesos
    // (ver `ResolvedSession`), y hacerlo con el mutex tomado bloquea la base para toda la
    // app.
    let resolved: std::collections::HashMap<String, super::sessions::ResolvedSession> = {
        let ids: Vec<String> = {
            let Ok(conn) = db.lock() else { return Err("base ocupada".to_string()) };
            let mut stmt = conn
                .prepare(
                    "SELECT t.id FROM tabs t JOIN windows w ON w.id = t.window_id
                     WHERE w.workspace_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([workspace_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        ids.into_iter().map(|id| {
            let resolved = resolve_for_archive(db, &id);
            (id, resolved)
        }).collect()
    };

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
        let resolved = resolved.get(tab_id.as_str()).cloned().unwrap_or_default();
        archive_tab_row(&conn, tab_id, workspace_id, &resolved)?;
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
pub(crate) fn move_open_windows_to_workspace(
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
