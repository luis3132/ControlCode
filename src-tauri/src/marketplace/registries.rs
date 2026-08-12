//! Alta, baja y refresco de los repositorios de skills.
//!
//! Cada fuente concreta (carpeta local, repo de GitHub, skills.sh) vive en su propio
//! módulo; acá está lo que es común a todas: el CRUD, el cache y a quién delegar.

use crate::database::DbConnection;
use crate::skills::{install_skill_internal, SkillInfo};
use rusqlite::params;
use std::path::PathBuf;
use uuid::Uuid;

use super::github::{fetch_github_registry, install_from_github, normalize_github_location, parse_github_location};
use super::local::scan_local_registry;
use super::skillssh::{install_from_skillssh, normalize_owner_filter, refresh_skillssh};
use super::types::{now_ts, MarketplaceSkillEntry, ProgressReporter, RegistrySummary};

fn row_to_summary(row: &rusqlite::Row) -> rusqlite::Result<RegistrySummary> {
    let cache_json: Option<String> = row.get(6)?;
    let skill_count = cache_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<MarketplaceSkillEntry>>(j).ok())
        .map(|v| v.len() as i64)
        .unwrap_or(0);
    Ok(RegistrySummary {
        id: row.get(0)?,
        name: row.get(1)?,
        source_type: row.get(2)?,
        location: row.get(3)?,
        priority: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        last_fetched: row.get(7)?,
        skill_count,
        error: row.get(8)?,
    })
}

const REGISTRY_COLUMNS: &str =
    "id, name, source_type, location, priority, enabled, cache_json, last_fetched, cache_error";

#[tauri::command]
pub fn list_registries(db: tauri::State<DbConnection>) -> Result<Vec<RegistrySummary>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {REGISTRY_COLUMNS} FROM registries ORDER BY priority ASC, created_at ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_summary)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// `id` lo puede proponer el frontend: los eventos `cc-registry-progress` viajan
/// etiquetados con el id del registry, y como esta llamada recién resuelve cuando el
/// repo terminó de resolverse (que es justo lo que se está reportando), quien quiera
/// mostrar el progreso necesita conocer el id ANTES de llamar. Si no viene, se genera acá.
#[tauri::command]
pub async fn add_registry(
    id: Option<String>,
    name: String,
    source_type: String,
    location: String,
    db: tauri::State<'_, DbConnection>,
    app: tauri::AppHandle,
) -> Result<RegistrySummary, String> {
    if !matches!(source_type.as_str(), "local" | "github" | "skillssh") {
        return Err(format!(
            "Tipo de registry no soportado todavía: {source_type} \
             (solo 'local', 'github' o 'skillssh')"
        ));
    }

    // La ubicación se guarda ya normalizada (un link de GitHub queda como `owner/repo`),
    // así la lista de repos muestra siempre la misma forma sin importar cómo se agregó.
    let location = match source_type.as_str() {
        "github" => {
            // Se valida acá para fallar con un mensaje claro antes de crear la fila, en vez
            // de dejar un registry roto que solo se queja al refrescarse.
            parse_github_location(&location)?;
            normalize_github_location(&location)
        }
        // Para skills.sh la ubicación no es un lugar sino un filtro opcional por
        // publicador; vacío significa "todo el directorio".
        "skillssh" => normalize_owner_filter(&location)?,
        _ => location.trim().to_string(),
    };

    let id = id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| Uuid::new_v4().to_string());
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let next_priority: i32 = conn
            .query_row("SELECT COALESCE(MAX(priority), -1) + 1 FROM registries", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![id, name, source_type, location, next_priority, now_ts()],
        )
        .map_err(|e| e.to_string())?;
    }
    refresh_registry_internal(&id, &db, app).await
}

/// Borra un repositorio Y las skills que se instalaron desde él.
///
/// La cascada es deliberada: las copias globales viven bajo la carpeta de su repo, así que
/// dejar el repo fuera y las skills adentro deja un bucket huérfano que ya no se puede
/// refrescar ni actualizar. El frontend avisa antes y lista exactamente qué se va a borrar
/// (ver `registry_skills`) — esto nunca debe correr sin esa confirmación.
///
/// Devuelve cuántas skills se borraron, para poder informarlo después de la operación.
#[tauri::command]
pub fn remove_registry(id: String, db: tauri::State<DbConnection>) -> Result<usize, String> {
    // Primero las skills: cada borrado necesita leer `registry_id`, que desaparece con la
    // fila del repo. Además retira sus symlinks de los proyectos, que es la parte que la
    // cascada de la FK no puede hacer sola.
    let removed = crate::skills::delete_skills_of_registry(&id, &db)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM registries WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(removed)
}

#[tauri::command]
pub fn set_registry_enabled(
    id: String,
    enabled: bool,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE registries SET enabled = ?1 WHERE id = ?2",
        params![enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_registry(id: String, name: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("El nombre no puede estar vacío".to_string());
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    let affected = conn
        .execute("UPDATE registries SET name = ?1 WHERE id = ?2", params![trimmed, id])
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("Registry no encontrado".to_string());
    }
    Ok(())
}

/// Reordena prioridades a partir del orden final de ids que manda el frontend
/// (drag-and-drop de la lista de repos en la vista de gestión).
#[tauri::command]
pub fn reorder_registries(ids: Vec<String>, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE registries SET priority = ?1 WHERE id = ?2",
            params![i as i32, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn refresh_registry(
    id: String,
    db: tauri::State<'_, DbConnection>,
    app: tauri::AppHandle,
) -> Result<RegistrySummary, String> {
    refresh_registry_internal(&id, &db, app).await
}

/// Vuelve a resolver la lista de skills de un registry (fetch de red para `github`, scan
/// de filesystem para `local`) y cachea el resultado en `cache_json`. Nunca mantiene el
/// lock de SQLite durante el `.await` de red: lee los datos de la fila, suelta el lock,
/// hace el trabajo async, y vuelve a tomar el lock (corto) solo para escribir el resultado.
async fn refresh_registry_internal(
    id: &str,
    db: &DbConnection,
    app: tauri::AppHandle,
) -> Result<RegistrySummary, String> {
    let progress = ProgressReporter::new(app, id);
    let (name, source_type, location, priority, enabled) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name, source_type, location, priority, enabled FROM registries WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i32>(3)?,
                    r.get::<_, i64>(4)? != 0,
                ))
            },
        )
        .map_err(|e| e.to_string())?
    };

    let result: Result<Vec<MarketplaceSkillEntry>, String> = match source_type.as_str() {
        "local" => scan_local_registry(id, &name, &location, &progress),
        "github" => fetch_github_registry(id, &name, &location, &progress).await,
        "skillssh" => {
            progress.phase("connecting");
            refresh_skillssh(db, id).await
        }
        other => Err(format!("Tipo de registry desconocido: {other}")),
    };

    progress.phase("saving");

    let now = now_ts();
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        match &result {
            Ok(entries) => {
                let json = serde_json::to_string(entries).unwrap_or_else(|_| "[]".to_string());
                conn.execute(
                    "UPDATE registries SET cache_json = ?1, cache_error = NULL, last_fetched = ?2 WHERE id = ?3",
                    params![json, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
            Err(e) => {
                conn.execute(
                    "UPDATE registries SET cache_error = ?1, last_fetched = ?2 WHERE id = ?3",
                    params![e, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let skill_count = result.as_ref().map(|v| v.len() as i64).unwrap_or(0);
    match &result {
        Ok(entries) => {
            let n = entries.len() as u32;
            progress.emit("done", n, Some(n), None);
        }
        Err(e) => progress.emit("error", 0, None, Some(e.clone())),
    }

    Ok(RegistrySummary {
        id: id.to_string(),
        name,
        source_type,
        location,
        priority,
        enabled,
        last_fetched: Some(now),
        skill_count,
        error: result.err(),
    })
}

/// Skills agregadas de todos los registries habilitados (orden de prioridad), leídas de
/// `cache_json` — no dispara ningún fetch: el usuario refresca explícitamente desde la UI
/// (botón por repo, o "refrescar todos"), así el marketplace nunca bloquea su propia
/// carga esperando a la red.
#[tauri::command]
pub fn list_marketplace_skills(
    query: Option<String>,
    category: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<Vec<MarketplaceSkillEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT name, cache_json FROM registries WHERE enabled = 1 ORDER BY priority ASC")
        .map_err(|e| e.to_string())?;
    let cached: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let query_lower = query.as_deref().map(|q| q.to_lowercase());
    let mut out = Vec::new();
    for (live_name, json) in cached {
        let Some(json) = json else { continue };
        let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(&json).unwrap_or_default();
        for mut entry in entries {
            // El nombre cacheado puede haber quedado viejo si el usuario renombró el
            // registry después del último refresh — se pisa acá en vez de invalidar el
            // cache entero solo por un rename.
            entry.registry_name = live_name.clone();
            if let Some(cat) = &category {
                if !entry.categories.iter().any(|c| c == cat) {
                    continue;
                }
            }
            if let Some(q) = &query_lower {
                let haystack = format!("{} {}", entry.name, entry.description.as_deref().unwrap_or(""))
                    .to_lowercase();
                if !haystack.contains(q.as_str()) {
                    continue;
                }
            }
            out.push(entry);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn install_marketplace_skill(
    registry_id: String,
    skill_id: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<SkillInfo, String> {
    let (source_type, location, registry_name, entries) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let (source_type, location, registry_name, cache_json): (String, String, String, Option<String>) = conn
            .query_row(
                "SELECT source_type, location, name, cache_json FROM registries WHERE id = ?1",
                [&registry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| "Registry no encontrado".to_string())?;
        let entries: Vec<MarketplaceSkillEntry> = cache_json
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        (source_type, location, registry_name, entries)
    };

    // La copia global va a parar a la carpeta de este repo, y la fila guarda de dónde vino
    // para poder mostrar el badge en la lista de skills.
    let origin = Some((registry_id.as_str(), registry_name.as_str()));

    let entry = entries
        .into_iter()
        .find(|e| e.id == skill_id)
        .ok_or_else(|| "Esta skill ya no está en el registry (probá refrescarlo)".to_string())?;

    match source_type.as_str() {
        "local" => {
            let file = PathBuf::from(&location).join(&entry.folder_path).join("SKILL.md");
            install_skill_internal(&file.to_string_lossy(), None, origin, &db)
        }
        "github" => install_from_github(&location, &entry, origin, &db).await,
        "skillssh" => install_from_skillssh(&entry, origin, &db).await,
        other => Err(format!("Tipo de registry desconocido: {other}")),
    }
}

#[tauri::command]
pub fn preview_registry_location(source_type: String, location: String) -> Result<String, String> {
    match source_type.as_str() {
        "github" => {
            let (owner, repo, branch, subpath) = parse_github_location(&location)?;
            let mut out = format!("{owner}/{repo}");
            if let Some(b) = branch {
                out.push('@');
                out.push_str(&b);
            }
            if let Some(s) = subpath {
                out.push(':');
                out.push_str(&s);
            }
            Ok(out)
        }
        "skillssh" => match normalize_owner_filter(&location)? {
            o if o.is_empty() => Ok("todo skills.sh".to_string()),
            owner => Ok(format!("skills.sh · solo {owner}")),
        },
        "local" => {
            let path = PathBuf::from(location.trim());
            if !path.is_dir() {
                return Err(format!("{} no es una carpeta accesible", path.display()));
            }
            Ok(path.to_string_lossy().to_string())
        }
        other => Err(format!("Tipo de registry no soportado: {other}")),
    }
}
