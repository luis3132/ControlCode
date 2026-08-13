//! Los comandos guardados ("entorno conda" → `conda activate ml`) y su CRUD.

use crate::database::DbConnection;

use super::steps::PrelaunchPreset;
use crate::util::now_ts;

/// Nombres vacíos o solo espacios harían un preset imposible de elegir en la UI y de
/// nombrar desde `ccode --pre-preset`.
pub fn validate_preset(name: &str, command: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    if command.trim().is_empty() {
        return Err("El comando no puede estar vacío".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_prelaunch_presets(
    db: tauri::State<DbConnection>,
) -> Result<Vec<PrelaunchPreset>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, command, created_at FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PrelaunchPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Crea o actualiza. `id` vacío/ausente = alta.
#[tauri::command]
pub fn save_prelaunch_preset(
    id: Option<String>,
    name: String,
    command: String,
    db: tauri::State<DbConnection>,
) -> Result<PrelaunchPreset, String> {
    let name = name.trim().to_string();
    let command = command.trim().to_string();
    validate_preset(&name, &command)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    let id = id.filter(|s| !s.is_empty());
    let preset = match id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE prelaunch_presets SET name = ?1, command = ?2 WHERE id = ?3",
                    rusqlite::params![name, command, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("Ese comando guardado ya no existe".into());
            }
            let created_at = conn
                .query_row("SELECT created_at FROM prelaunch_presets WHERE id = ?1", [&id], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())?;
            PrelaunchPreset { id, name, command, created_at }
        }
        None => {
            let preset = PrelaunchPreset {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                command,
                created_at: now_ts(),
            };
            conn.execute(
                "INSERT INTO prelaunch_presets (id, name, command, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    preset.id,
                    preset.name,
                    preset.command,
                    preset.created_at
                ],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    format!("Ya existe un comando guardado llamado '{}'", preset.name)
                } else {
                    e.to_string()
                }
            })?;
            preset
        }
    };
    Ok(preset)
}

#[tauri::command]
pub fn delete_prelaunch_preset(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM prelaunch_presets WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
