//! Consultas de `settings`: el key-value genérico de la app.
//!
//! Las versiones que reciben `&DbConnection` existen para poder llamarse desde otros
//! módulos backend (ej. `skills::resolve_skills_dir`) sin pasar por la capa de invoke.

use rusqlite::OptionalExtension;

use crate::database::DbConnection;

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
