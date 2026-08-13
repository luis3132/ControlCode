//! Resolver la cadena: de los pasos guardados a los comandos concretos a ejecutar.

use crate::database::DbConnection;

use super::steps::PrelaunchStep;

/// Convierte la cadena guardada en los comandos concretos a ejecutar, en orden.
///
/// Toma `&Connection` y no `&DbConnection` a propósito: así se puede llamar desde código
/// que YA tiene el lock tomado sin caer en un deadlock (el mutex de la app no es
/// reentrante). Ver `accounts::dir_for_conn`, que existe por lo mismo.
pub fn resolve_conn(
    conn: &rusqlite::Connection,
    steps: &[PrelaunchStep],
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(steps.len());
    for step in steps {
        match step {
            PrelaunchStep::Command { command } => {
                let command = command.trim();
                if !command.is_empty() {
                    out.push(command.to_string());
                }
            }
            PrelaunchStep::Preset { preset_id } => {
                let found: Option<(String, String)> = conn
                    .query_row(
                        "SELECT name, command FROM prelaunch_presets WHERE id = ?1",
                        [preset_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok();
                // Falla en vez de omitir: un paso que desaparece en silencio deja al
                // agente corriendo fuera del entorno que el usuario pidió.
                let (_, command) = found.ok_or_else(|| {
                    "Un comando de pre-lanzamiento guardado ya no existe. Revisá la cadena \
                     en Configuración → Pre-lanzamiento."
                        .to_string()
                })?;
                let command = command.trim();
                if !command.is_empty() {
                    out.push(command.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// Igual que `resolve_conn`, tomando el lock. No llamar con el lock ya tomado.
pub fn resolve(db: &DbConnection, steps: &[PrelaunchStep]) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    resolve_conn(&conn, steps)
}

/// Lo que invoca el frontend justo antes de spawnear, igual que `agent_account_env`: si un
/// preset fue borrado mientras la tab estaba guardada, se entera acá y no arranca.
#[tauri::command]
pub fn resolve_prelaunch(
    steps: Vec<PrelaunchStep>,
    db: tauri::State<DbConnection>,
) -> Result<Vec<String>, String> {
    resolve(&db, &steps)
}
