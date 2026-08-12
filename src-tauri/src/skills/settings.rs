//! El directorio global donde viven las copias de las skills instaladas.

use rusqlite::OptionalExtension;
use std::path::PathBuf;

use crate::database::DbConnection;

pub(super) fn resolve_skills_dir(db: &DbConnection) -> Result<PathBuf, String> {
    let value = crate::database::get_setting(db, "skills_dir")?;
    let dir = skills_dir_from_value(value)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Igual que `resolve_skills_dir` pero a partir de una `&Connection` ya lockeada — la
/// reconciliación de symlinks corre en medio de operaciones que ya tienen el lock de la
/// DB tomado (attach/detach, cierre de tabs/ventanas), y volver a lockear ahí sería un
/// deadlock. No crea el directorio: acá solo se usa para decidir si un symlink existente
/// apunta a la copia global (o sea, si lo gestiona Control Code) o es del usuario.
pub(super) fn skills_dir_from_conn(conn: &rusqlite::Connection) -> Result<PathBuf, String> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'skills_dir'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    skills_dir_from_value(value)
}

pub(super) fn skills_dir_from_value(value: Option<String>) -> Result<PathBuf, String> {
    match value {
        Some(v) => Ok(PathBuf::from(v)),
        None => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            Ok(home.join(".controlcode").join("skills"))
        }
    }
}

#[tauri::command]
pub fn get_skills_dir(db: tauri::State<DbConnection>) -> Result<String, String> {
    let dir = resolve_skills_dir(&db)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_skills_dir(path: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    crate::database::db_set_setting("skills_dir".to_string(), path, db)
}
