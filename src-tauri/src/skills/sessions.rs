//! Las skills que tenía una sesión archivada, y cómo volver a ponérselas al reabrirla.

use rusqlite::OptionalExtension;

use crate::database::DbConnection;

use super::links::attach_skill;
use super::types::{SessionSkillStatus, SkillSource};

/// Busca una skill por nombre entre los repos habilitados, leyendo el cache que dejó el
/// último refresh (no hace red: si el cache está viejo, el usuario refresca desde el
/// Marketplace). Devuelve la primera coincidencia por orden de prioridad de repo.
fn find_in_marketplace(conn: &rusqlite::Connection, name: &str) -> Option<SkillSource> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, cache_json FROM registries
             WHERE enabled = 1 AND cache_json IS NOT NULL ORDER BY priority ASC",
        )
        .ok()?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    let wanted = name.to_lowercase();
    for (registry_id, registry_name, cache_json) in rows {
        let entries: Vec<crate::marketplace::MarketplaceSkillEntry> =
            serde_json::from_str(&cache_json).unwrap_or_default();
        if let Some(entry) = entries.iter().find(|e| {
            e.name.to_lowercase() == wanted || e.id.to_lowercase() == wanted
        }) {
            return Some(SkillSource {
                registry_id,
                registry_name,
                marketplace_skill_id: entry.id.clone(),
            });
        }
    }
    None
}

/// Resuelve, para cada skill archivada de una sesión, si sigue instalada y —si no— dónde
/// volver a bajarla. Es lo que le permite a la UI avisar "esta sesión tenía N skills y
/// falta X" antes de reabrirla.
#[tauri::command]
pub fn check_session_skills(
    history_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<SessionSkillStatus>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let archived = crate::database::archived_skills_of_session(&conn, &history_id)?;

    let mut out = Vec::with_capacity(archived.len());
    for a in archived {
        // Primero la copia EXACTA que tenía la sesión, por id.
        let by_id: Option<String> = if a.id.is_empty() {
            None
        } else {
            conn.query_row("SELECT id FROM skills WHERE id = ?1", [&a.id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
        };

        // Si esa copia ya no está, se puede aceptar otra instalada con el mismo nombre —
        // pero SOLO si hay una sola. Con dos homónimas no hay forma de saber cuál quería
        // el usuario (pueden ser de autores distintos y hacer cosas distintas), y elegir
        // al azar le montaría en la sesión una skill que nunca tuvo. En ese caso se
        // reporta como faltante y el diálogo le deja decidir.
        let (installed_skill_id, substituted) = match by_id {
            Some(id) => (Some(id), false),
            None => {
                let same_name: Vec<String> = {
                    let mut stmt = conn
                        .prepare("SELECT id FROM skills WHERE name = ?1")
                        .map_err(|e| e.to_string())?;
                    let rows = stmt
                        .query_map([&a.name], |r| r.get::<_, String>(0))
                        .map_err(|e| e.to_string())?;
                    rows.filter_map(|r| r.ok()).collect()
                };
                match same_name.len() {
                    1 => (Some(same_name[0].clone()), true),
                    _ => (None, false),
                }
            }
        };

        let ambiguous = installed_skill_id.is_none()
            && !a.id.is_empty()
            && conn
                .query_row(
                    "SELECT COUNT(*) FROM skills WHERE name = ?1",
                    [&a.name],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 1;

        let available_from = if installed_skill_id.is_none() {
            find_in_marketplace(&conn, &a.name)
        } else {
            None
        };

        out.push(SessionSkillStatus {
            name: a.name,
            scope: a.scope,
            installed_skill_id,
            substituted,
            ambiguous,
            available_from,
        });
    }
    Ok(out)
}

/// Reattachea a una tab las skills que tenía la sesión archivada y siguen instaladas.
/// Devuelve las que NO se pudieron restaurar (siguen faltando), para que la UI pueda
/// insistir con la advertencia si hiciera falta.
///
/// Todo se attachea con scope='tab' aunque en su momento viniera del workspace: la sesión
/// se está reabriendo como una tab puntual, y heredar del workspace de destino (que puede
/// ser otro) no reproduciría lo que esa terminal tenía.
#[tauri::command]
pub fn restore_session_skills(
    history_id: String,
    workspace_id: String,
    tab_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<String>, String> {
    let statuses = check_session_skills(history_id, db.clone())?;

    let mut still_missing = Vec::new();
    for status in statuses {
        if status.is_missing() {
            still_missing.push(status.name);
            continue;
        }
        match status.installed_skill_id {
            Some(skill_id) => {
                // Best-effort por skill: un conflicto de symlink en una no debe impedir
                // que se restauren las demás.
                let _ = attach_skill(
                    skill_id,
                    workspace_id.clone(),
                    "tab".to_string(),
                    Some(tab_id.clone()),
                    db.clone(),
                );
            }
            // `is_missing()` ya cubrió este caso arriba.
            None => unreachable!(),
        }
    }
    Ok(still_missing)
}
