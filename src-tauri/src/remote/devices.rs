//! Los teléfonos emparejados.

use rusqlite::Connection;
use serde::Serialize;

use crate::util::now_ts;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Su clave pública: con eso se presenta ante el relay y con eso se le cifra.
    pub id: String,
    pub name: String,
    pub platform: Option<String>,
    #[serde(skip_serializing)]
    pub push_token: Option<String>,
    pub has_push: bool,
    pub paired_at: i64,
    pub last_seen: Option<i64>,
}

const COLUMNS: &str = "id, name, platform, push_token, paired_at, last_seen";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Device> {
    let push_token: Option<String> = r.get(3)?;
    Ok(Device {
        id: r.get(0)?,
        name: r.get(1)?,
        platform: r.get(2)?,
        has_push: push_token.is_some(),
        push_token,
        paired_at: r.get(4)?,
        last_seen: r.get(5)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Device>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLUMNS} FROM remote_devices ORDER BY paired_at"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Un nombre que llega de afuera: corto y de una línea.
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    let name = name.trim();
    if name.is_empty() { "Teléfono".into() } else { name.to_string() }
}

/// Alta o, si ya estaba (volvió a escanear el QR), actualización.
pub fn upsert(conn: &Connection, id: &str, name: &str, platform: Option<&str>, push_token: Option<&str>) -> Result<(), String> {
    let platform = platform.map(|p| p.chars().take(20).collect::<String>());
    conn.execute(
        "INSERT INTO remote_devices (id, name, platform, push_token, paired_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
             push_token = COALESCE(excluded.push_token, remote_devices.push_token)",
        rusqlite::params![id, clean_name(name), platform, push_token, now_ts()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_push_token(conn: &Connection, id: &str, token: Option<&str>) -> Result<(), String> {
    conn.execute("UPDATE remote_devices SET push_token = ?1 WHERE id = ?2", rusqlite::params![token, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn touch(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE remote_devices SET last_seen = ?1 WHERE id = ?2", rusqlite::params![now_ts(), id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM remote_devices WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}
