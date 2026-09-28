//! El CRUD de las conexiones.
//!
//! Las funciones sobre `&Connection` existen para los tests y para las tools de los
//! agentes (`ssh::tools`), que llegan sin `tauri::State`.

use rusqlite::{Connection, OptionalExtension, Row};

use super::args::normalize_draft;
use super::model::{SshConnection, SshConnectionDraft};
use crate::database::DbConnection;
use crate::util::now_ts;

const COLUMNS: &str = "id, name, host, user, port, identity_file, remote_dir, agent_access, created_at";

fn from_row(row: &Row) -> rusqlite::Result<SshConnection> {
    Ok(SshConnection {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        user: row.get(3)?,
        port: row.get::<_, Option<i64>>(4)?.and_then(|p| u16::try_from(p).ok()),
        identity_file: row.get(5)?,
        remote_dir: row.get(6)?,
        agent_access: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
    })
}

pub fn list_conn(conn: &Connection) -> Result<Vec<SshConnection>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM ssh_connections ORDER BY name COLLATE NOCASE"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], from_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get_conn(conn: &Connection, id: &str) -> Result<SshConnection, String> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM ssh_connections WHERE id = ?1"), [id], from_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Esa conexión ya no existe".to_string())
}

/// Por nombre, sin distinguir mayúsculas: es lo que escriben los agentes.
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<SshConnection>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM ssh_connections WHERE name = ?1 COLLATE NOCASE"),
        [name.trim()],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Crea o actualiza. Sin `id` = alta.
pub fn save_conn(conn: &Connection, draft: SshConnectionDraft) -> Result<SshConnection, String> {
    let d = normalize_draft(draft)?;

    // El nombre es único sin distinguir mayúsculas (así lo busca `find_by_name`), y el
    // `UNIQUE` de la tabla sí distingue: se controla acá.
    if let Some(other) = find_by_name(conn, &d.name)?
        && Some(&other.id) != d.id.as_ref()
    {
        return Err(format!("Ya existe una conexión llamada '{}'", other.name));
    }

    let id = match d.id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE ssh_connections SET name = ?1, host = ?2, user = ?3, port = ?4,
                     identity_file = ?5, remote_dir = ?6, agent_access = ?7 WHERE id = ?8",
                    rusqlite::params![
                        d.name, d.host, d.user, d.port, d.identity_file, d.remote_dir,
                        d.agent_access as i64, id
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("Esa conexión ya no existe".into());
            }
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO ssh_connections
                 (id, name, host, user, port, identity_file, remote_dir, agent_access, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    id, d.name, d.host, d.user, d.port, d.identity_file, d.remote_dir,
                    d.agent_access as i64, now_ts()
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    get_conn(conn, &id)
}

pub fn delete_conn(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ssh_connections WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_ssh_connections(db: tauri::State<DbConnection>) -> Result<Vec<SshConnection>, String> {
    list_conn(&*db.lock().map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn save_ssh_connection(
    draft: SshConnectionDraft,
    db: tauri::State<DbConnection>,
) -> Result<SshConnection, String> {
    save_conn(&*db.lock().map_err(|e| e.to_string())?, draft)
}

#[tauri::command]
pub fn delete_ssh_connection(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    delete_conn(&*db.lock().map_err(|e| e.to_string())?, &id)
}
