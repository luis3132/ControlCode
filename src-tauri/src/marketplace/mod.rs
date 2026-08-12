//! Fase 6 — Marketplace y repositorios de skills configurables.
//!
//! Formato abierto de `registry.json` (opcional — sin él, se auto-escanean carpetas con
//! `SKILL.md` dentro de la fuente):
//! ```json
//! {
//!   "name": "Mi repo de skills",
//!   "skills": [
//!     {
//!       "id": "mi-skill",                 // opcional, default: nombre de la carpeta
//!       "name": "Mi Skill",               // opcional, default: id
//!       "description": "...",
//!       "path": "skills/mi-skill",        // carpeta relativa a la raíz del registry, contiene SKILL.md
//!       "categories": ["git"],
//!       "compatibleAgents": ["claude-code"]
//!     }
//!   ]
//! }
//! ```
//!
//! Fuentes soportadas: `local` (carpeta en disco), `github` (repo público, vía la API de
//! GitHub — sin autenticación, sujeto a su rate limit anónimo) y `skillssh` (el directorio
//! abierto de <https://skills.sh>, a través de su CLI oficial — ver `skillssh`). "URL con
//! manifest JSON" genérica y "git genérico" (clonar cualquier remoto) quedan pendientes
//! del plan original: requieren descubrir el listado de archivos de un servidor HTTP
//! arbitrario (no hay una API estándar para eso) y traer un cliente git embebido
//! respectivamente — ninguna de las dos es segura de improvisar sin poder probarla
//! contra una fuente real.

pub mod skillssh;

use crate::database::DbConnection;
use crate::skills::{install_skill_internal, scan_frontmatter_for_marketplace, SkillInfo};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ── Types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySummary {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub location: String,
    pub priority: i32,
    pub enabled: bool,
    pub last_fetched: Option<i64>,
    pub skill_count: i64,
    pub error: Option<String>,
}

/// Una skill tal como la ve el marketplace, ya resuelta contra su registry de origen.
/// `files` solo se usa para fuentes `github` (lista de paths del árbol del repo bajo
/// `folder_path`, para poder descargarlos uno a uno al instalar sin volver a pedir el
/// árbol completo); para `local` queda vacío porque la carpeta ya está en disco.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkillEntry {
    pub id: String,
    pub registry_id: String,
    pub registry_name: String,
    pub name: String,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub compatible_agents: Vec<String>,
    pub folder_path: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Instalaciones acumuladas, ya formateadas (`"3.3K"`). Solo lo informa `skillssh`; en
    /// las demás fuentes queda en `None` y la UI no muestra el dato. Va con `default` para
    /// que un `cache_json` escrito por una versión anterior siga leyéndose.
    #[serde(default)]
    pub installs: Option<String>,
}

/// Progreso de la resolución de un registry, emitido al frontend como evento
/// `cc-registry-progress`. `total` es `None` mientras la fase no sea contable (todavía no
/// sabemos cuántos archivos hay que mirar) — la UI muestra un spinner indeterminado en ese
/// caso y una barra con porcentaje cuando sí llega un total.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProgress {
    pub registry_id: String,
    /// "connecting" | "listing" | "scanning" | "saving" | "done" | "error"
    pub phase: String,
    pub current: u32,
    pub total: Option<u32>,
    /// Qué se está mirando ahora mismo (ej. el path de la skill), para dar sensación de
    /// avance real cuando el porcentaje se mueve lento.
    pub detail: Option<String>,
}

/// Emisor de progreso atado a un registry. Se pasa por las funciones de resolución para
/// que no tengan que conocer ni el nombre del evento ni el `AppHandle`.
struct ProgressReporter {
    app: tauri::AppHandle,
    registry_id: String,
}

impl ProgressReporter {
    fn new(app: tauri::AppHandle, registry_id: &str) -> Self {
        Self { app, registry_id: registry_id.to_string() }
    }

    fn emit(&self, phase: &str, current: u32, total: Option<u32>, detail: Option<String>) {
        use tauri::Emitter;
        // Best-effort: que no se pueda notificar el progreso nunca debe hacer fallar la
        // operación que se está reportando.
        let _ = self.app.emit(
            "cc-registry-progress",
            RegistryProgress {
                registry_id: self.registry_id.clone(),
                phase: phase.to_string(),
                current,
                total,
                detail,
            },
        );
    }

    /// Fase sin porcentaje posible todavía (resolver la branch, pedir el árbol del repo).
    fn phase(&self, phase: &str) {
        self.emit(phase, 0, None, None);
    }
}

#[derive(Deserialize)]
struct RegistryManifest {
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
    skills: Vec<RegistryManifestSkill>,
}

#[derive(Deserialize)]
struct RegistryManifestSkill {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    path: String,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default, rename = "compatibleAgents")]
    compatible_agents: Vec<String>,
}

// ── Registry CRUD ────────────────────────────────────────────────

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

// ── Fuente: carpeta local ────────────────────────────────────────

fn scan_local_registry(
    registry_id: &str,
    registry_name: &str,
    location: &str,
    progress: &ProgressReporter,
) -> Result<Vec<MarketplaceSkillEntry>, String> {
    progress.phase("listing");
    let base = PathBuf::from(location);
    if !base.is_dir() {
        return Err(format!("{location} no es una carpeta accesible"));
    }

    let manifest_path = base.join("registry.json");
    if manifest_path.is_file() {
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let manifest: RegistryManifest =
            serde_json::from_str(&raw).map_err(|e| format!("registry.json inválido: {e}"))?;
        let total = manifest.skills.len() as u32;
        let mut out = Vec::new();
        for (i, s) in manifest.skills.into_iter().enumerate() {
            progress.emit("scanning", i as u32, Some(total), Some(s.path.clone()));
            if !base.join(&s.path).join("SKILL.md").is_file() {
                continue; // declarada en el manifest pero ausente en disco, se saltea
            }
            let id = s.id.clone().unwrap_or_else(|| s.path.clone());
            out.push(MarketplaceSkillEntry {
                id,
                registry_id: registry_id.to_string(),
                registry_name: registry_name.to_string(),
                name: s.name.unwrap_or_else(|| s.path.clone()),
                description: s.description,
                categories: s.categories,
                compatible_agents: s.compatible_agents,
                folder_path: s.path,
                files: Vec::new(),
                installs: None,
            });
        }
        return Ok(out);
    }

    // Sin manifest: cada subcarpeta directa con un SKILL.md adentro es una skill (mismo
    // criterio "Scan automático" que el plan pide para repos sin manifest formal).
    let mut out = Vec::new();
    let dirs: Vec<PathBuf> = std::fs::read_dir(&base)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    let total = dirs.len() as u32;
    for (i, path) in dirs.into_iter().enumerate() {
        progress.emit(
            "scanning",
            i as u32,
            Some(total),
            path.file_name().map(|n| n.to_string_lossy().to_string()),
        );
        let skill_md = path.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&skill_md) else { continue };
        let meta = scan_frontmatter_for_marketplace(&content);
        let folder_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        out.push(MarketplaceSkillEntry {
            id: folder_name.clone(),
            registry_id: registry_id.to_string(),
            registry_name: registry_name.to_string(),
            name: meta.name.unwrap_or_else(|| folder_name.clone()),
            description: meta.description,
            categories: meta.categories,
            compatible_agents: meta.compatible_agents,
            folder_path: folder_name,
            files: Vec::new(),
            installs: None,
        });
    }
    Ok(out)
}

// ── Fuente: skills.sh ────────────────────────────────────────────

/// Valida el filtro por publicador de un registry `skillssh`. Vacío es válido y es el caso
/// normal: significa buscar en todo el directorio.
///
/// Acepta que le peguen el link del perfil (`https://skills.sh/vercel-labs`) además del
/// nombre pelado, por la misma razón que `normalize_github_location`: es lo que uno tiene
/// en el portapapeles al venir de la web.
fn normalize_owner_filter(input: &str) -> Result<String, String> {
    let raw = input.trim().trim_end_matches('/');
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);
    let owner = raw
        .rsplit('/')
        .find(|s| !s.is_empty())
        .filter(|s| !s.contains(".sh") && !s.contains("://"))
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if owner.is_empty() {
        return Ok(String::new());
    }
    // Mismas reglas que un usuario/organización de GitHub, que es de donde salen los
    // publicadores del directorio.
    let valido = owner.len() <= 39
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !owner.starts_with('-')
        && !owner.ends_with('-');
    if !valido {
        return Err(format!(
            "'{owner}' no parece un publicador de skills.sh. Dejalo vacío para buscar en \
             todo el directorio, o poné un usuario/organización de GitHub (ej. vercel-labs)."
        ));
    }
    Ok(owner)
}

/// Convierte un resultado del directorio en una entrada de marketplace.
///
/// `folder_path` guarda el `owner/repo/slug` completo: es lo único que hace falta para
/// volver a instalarla más tarde desde el cache, sin repetir la búsqueda.
fn skillssh_entry(
    hit: skillssh::SkillsShHit,
    registry_id: &str,
    registry_name: &str,
) -> MarketplaceSkillEntry {
    MarketplaceSkillEntry {
        id: hit.id.clone(),
        registry_id: registry_id.to_string(),
        registry_name: registry_name.to_string(),
        name: hit.slug.clone(),
        // El directorio no expone la descripción en la búsqueda — la única forma de
        // tenerla sería bajar cada skill entera, que son decenas de megas por búsqueda.
        // Se muestra el repo de origen, que es el dato que sí ayuda a elegir.
        description: Some(hit.source.clone()),
        categories: Vec::new(),
        compatible_agents: Vec::new(),
        folder_path: hit.id,
        files: Vec::new(),
        installs: hit.installs,
    }
}

/// Busca en los repositorios `skillssh` habilitados y deja los resultados en su cache.
///
/// El marketplace no puede listar skills.sh como lista a los otros repos: el directorio
/// tiene miles de skills y su CLI solo sabe buscar (no enumerar), así que la búsqueda es la
/// forma de navegarlo. Se llama desde el buscador del marketplace antes de releer la lista.
///
/// Guardar en `cache_json` no es solo para mostrar: instalar necesita reencontrar la skill
/// por id, y así lo último buscado sigue ahí al volver a la pantalla.
#[tauri::command]
pub async fn search_remote_registries(
    query: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<(), String> {
    search_remote_conn(&db, &query).await
}

/// El trabajo real de [`search_remote_registries`], sin la capa de Tauri, para poder
/// ejercitarlo contra una base de prueba.
pub async fn search_remote_conn(db: &DbConnection, query: &str) -> Result<(), String> {
    let targets: Vec<(String, String, String)> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, location FROM registries
                 WHERE source_type = 'skillssh' AND enabled = 1 ORDER BY priority ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    if targets.is_empty() {
        return Ok(());
    }

    for (id, name, owner) in targets {
        // La CLI es un proceso que bloquea; correrla en el hilo del runtime congelaría toda
        // la app mientras busca.
        let (q, owner_owned) = (query.to_string(), owner.clone());
        let found = tauri::async_runtime::spawn_blocking(move || {
            skillssh::search(&q, Some(owner_owned.as_str()))
        })
        .await
        .map_err(|e| e.to_string())?;

        let now = now_ts();
        let conn = db.lock().map_err(|e| e.to_string())?;
        match found {
            Ok(hits) => {
                let entries: Vec<MarketplaceSkillEntry> = hits
                    .into_iter()
                    .map(|h| skillssh_entry(h, &id, &name))
                    .collect();
                let json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
                conn.execute(
                    "UPDATE registries SET cache_json = ?1, cache_error = NULL, last_fetched = ?2
                     WHERE id = ?3",
                    params![json, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
            // Un fallo de búsqueda no puede tumbar el resto del marketplace: queda anotado
            // en el repositorio (la UI lo muestra ahí) y los demás siguen andando.
            Err(e) => {
                conn.execute(
                    "UPDATE registries SET cache_error = ?1, last_fetched = ?2 WHERE id = ?3",
                    params![e, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// "Refrescar" un repositorio de skills.sh no puede rebajar la lista completa —  no existe
/// tal cosa sin su API privada. Lo que sí puede es comprobar que la herramienta con la que
/// se lo consulta esté disponible, que es el único motivo real por el que esta fuente deja
/// de funcionar en una máquina. Los resultados de la última búsqueda se conservan.
/// `ensure_npx` arranca un proceso y espera: eso NO puede pasar en el hilo del runtime.
/// Refrescar repositorios recorre todos en serie, así que dejar esta comprobación bloqueando
/// congelaba un worker durante todo el arranque de Node — y la instalación de skills, que es
/// async, quedaba encolada detrás sin motivo aparente. La búsqueda y la instalación ya salían
/// del runtime con `spawn_blocking`; esto se me había escapado.
async fn refresh_skillssh(db: &DbConnection, id: &str) -> Result<Vec<MarketplaceSkillEntry>, String> {
    tauri::async_runtime::spawn_blocking(skillssh::ensure_npx)
        .await
        .map_err(|e| e.to_string())??;

    let conn = db.lock().map_err(|e| e.to_string())?;
    let cache: Option<String> = conn
        .query_row("SELECT cache_json FROM registries WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(cache.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
}

/// Instala una skill del directorio: la CLI la deja en una carpeta temporal nuestra y de
/// ahí sigue por el mismo camino que cualquier otra fuente.
async fn install_from_skillssh(
    entry: &MarketplaceSkillEntry,
    origin: crate::skills::SkillOrigin<'_>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let target = skillssh::add_target(&entry.folder_path)
        .ok_or_else(|| format!("Identificador de skill inesperado: {}", entry.folder_path))?;

    let staging = std::env::temp_dir().join(format!("controlcode-skillssh-{}", Uuid::new_v4()));
    let staged = {
        let staging = staging.clone();
        tauri::async_runtime::spawn_blocking(move || skillssh::install_into(&staging, &target))
            .await
            .map_err(|e| e.to_string())?
    };

    let result = staged.and_then(|dir| {
        install_skill_internal(&dir.join("SKILL.md").to_string_lossy(), None, origin, db)
    });

    let _ = std::fs::remove_dir_all(&staging);
    result
}

// ── Fuente: repo de GitHub ───────────────────────────────────────

#[derive(Deserialize)]
struct GhRepoInfo {
    default_branch: String,
}

#[derive(Deserialize)]
struct GhTreeResponse {
    tree: Vec<GhTreeEntry>,
}

#[derive(Deserialize)]
struct GhTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

fn gh_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ControlCode-App")
        .build()
        .map_err(|e| e.to_string())
}

const GITHUB_FORMAT_HINT: &str =
    "Pegá el link del repo (https://github.com/owner/repo) o escribilo como owner/repo";

/// Reescribe un link de GitHub como la forma corta `owner/repo[@branch][:subpath]`, para
/// que el resto del módulo tenga un único formato que entender. Acepta lo que el usuario
/// tenga a mano al copiar:
///
/// - `https://github.com/owner/repo` (con o sin `.git`, `/` final o `?query#hash`)
/// - `https://github.com/owner/repo/tree/branch/sub/carpeta` — la vista de navegación del
///   repo, que es la URL que uno copia estando parado en una subcarpeta
/// - `git@github.com:owner/repo.git` (remoto SSH)
/// - `github.com/owner/repo` (sin esquema)
///
/// Cualquier otra cosa se devuelve tal cual: puede ser ya la forma corta, y si no lo es,
/// el error correspondiente lo da `parse_github_location`.
fn normalize_github_location(input: &str) -> String {
    let raw = input.trim();
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);

    let rest = raw
        .strip_prefix("git@github.com:")
        .or_else(|| raw.strip_prefix("ssh://git@github.com/"))
        .or_else(|| raw.strip_prefix("https://github.com/"))
        .or_else(|| raw.strip_prefix("http://github.com/"))
        .or_else(|| raw.strip_prefix("https://www.github.com/"))
        .or_else(|| raw.strip_prefix("github.com/"));

    let Some(rest) = rest else { return raw.to_string() };

    let rest = rest.trim_matches('/');
    let mut segments = rest.split('/').filter(|s| !s.is_empty());
    let (Some(owner), Some(repo)) = (segments.next(), segments.next()) else {
        return raw.to_string();
    };
    let repo = repo.strip_suffix(".git").unwrap_or(repo);

    // `/tree/<branch>/<subpath...>` y `/blob/<branch>/<subpath...>` son las dos formas en
    // que GitHub arma la URL cuando estás navegando dentro del repo.
    let mut out = format!("{owner}/{repo}");
    if matches!(segments.next(), Some("tree") | Some("blob")) {
        if let Some(branch) = segments.next() {
            out.push('@');
            out.push_str(branch);
            let subpath: Vec<&str> = segments.collect();
            if !subpath.is_empty() {
                out.push(':');
                out.push_str(&subpath.join("/"));
            }
        }
    }
    out
}

/// Parsea `owner/repo[@branch][:subpath]` — ej. `anthropics/skills`,
/// `anthropics/skills@main:examples`. Acepta también un link completo, normalizándolo
/// primero (ver `normalize_github_location`), para que un registry guardado con una URL
/// cruda por una versión anterior siga funcionando.
fn parse_github_location(
    location: &str,
) -> Result<(String, String, Option<String>, Option<String>), String> {
    let normalized = normalize_github_location(location);
    let (repo_part, subpath) = match normalized.split_once(':') {
        Some((r, p)) => (r, Some(p.trim_start_matches('/').trim_end_matches('/').to_string())),
        None => (normalized.as_str(), None),
    };
    let (owner_repo, branch) = match repo_part.split_once('@') {
        Some((r, b)) => (r, Some(b.to_string())),
        None => (repo_part, None),
    };
    let mut parts = owner_repo.splitn(2, '/');
    let owner = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GITHUB_FORMAT_HINT.to_string())?;
    let repo = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('/'))
        .ok_or_else(|| GITHUB_FORMAT_HINT.to_string())?;
    Ok((owner.to_string(), repo.to_string(), branch, subpath))
}

/// Valida y normaliza una ubicación desde la UI sin llegar a crear el registry — el
/// diálogo de "agregar repositorio" la usa mientras el usuario tipea, para mostrarle en
/// qué se traduce el link que pegó (o el error, si no es un repo válido).
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

async fn resolve_branch(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    branch_opt: Option<String>,
) -> Result<String, String> {
    if let Some(b) = branch_opt {
        return Ok(b);
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("No se pudo acceder a {owner}/{repo} ({})", resp.status()));
    }
    let info: GhRepoInfo = resp.json().await.map_err(|e| e.to_string())?;
    Ok(info.default_branch)
}

async fn fetch_raw_github(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    branch: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("No se pudo descargar {path} ({})", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

async fn fetch_github_registry(
    registry_id: &str,
    registry_name: &str,
    location: &str,
    progress: &ProgressReporter,
) -> Result<Vec<MarketplaceSkillEntry>, String> {
    let (owner, repo, branch_opt, subpath) = parse_github_location(location)?;
    let client = gh_client()?;

    progress.phase("connecting");
    let branch = resolve_branch(&client, &owner, &repo, branch_opt).await?;

    progress.phase("listing");
    let tree_url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1");
    let resp = client.get(&tree_url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "No se pudo leer el árbol de {owner}/{repo}@{branch} ({})",
            resp.status()
        ));
    }
    let tree: GhTreeResponse = resp.json().await.map_err(|e| e.to_string())?;

    let prefix = subpath.unwrap_or_default();
    let scoped: Vec<&GhTreeEntry> = tree
        .tree
        .iter()
        .filter(|e| e.kind == "blob")
        .filter(|e| prefix.is_empty() || e.path.starts_with(&format!("{prefix}/")))
        .collect();

    let manifest_path = if prefix.is_empty() {
        "registry.json".to_string()
    } else {
        format!("{prefix}/registry.json")
    };

    if scoped.iter().any(|e| e.path == manifest_path) {
        let raw = fetch_raw_github(&client, &owner, &repo, &branch, &manifest_path).await?;
        let text = String::from_utf8_lossy(&raw);
        let manifest: RegistryManifest =
            serde_json::from_str(&text).map_err(|e| format!("registry.json inválido: {e}"))?;

        let total = manifest.skills.len() as u32;
        let mut out = Vec::new();
        for (i, s) in manifest.skills.into_iter().enumerate() {
            progress.emit("scanning", i as u32, Some(total), Some(s.path.clone()));
            let folder = if prefix.is_empty() { s.path.clone() } else { format!("{prefix}/{}", s.path) };
            let files: Vec<String> = scoped
                .iter()
                .map(|e| e.path.clone())
                .filter(|p| p.starts_with(&format!("{folder}/")))
                .collect();
            if files.is_empty() {
                continue; // carpeta declarada en el manifest pero ausente en el árbol real
            }
            let default_name = folder.rsplit('/').next().unwrap_or(&folder).to_string();
            out.push(MarketplaceSkillEntry {
                id: s.id.clone().unwrap_or_else(|| default_name.clone()),
                registry_id: registry_id.to_string(),
                registry_name: registry_name.to_string(),
                name: s.name.unwrap_or(default_name),
                description: s.description,
                categories: s.categories,
                compatible_agents: s.compatible_agents,
                folder_path: folder,
                files,
                installs: None,
            });
        }
        return Ok(out);
    }

    // Sin manifest: cada SKILL.md del árbol (bajo el subpath, si hay uno) define una
    // skill — se lee su contenido para sacar nombre/descripción del frontmatter.
    let skill_md_paths: Vec<String> = scoped
        .iter()
        .filter(|e| e.path.rsplit('/').next().map(|n| n.eq_ignore_ascii_case("SKILL.md")).unwrap_or(false))
        .map(|e| e.path.clone())
        .collect();

    // Esta es la parte lenta y la única realmente contable: un GET por cada SKILL.md del
    // repo. Un repo grande son decenas de requests secuenciales, así que el porcentaje que
    // sale de acá es el que le da sentido a la barra.
    let total = skill_md_paths.len() as u32;
    let mut out = Vec::new();
    for (i, skill_md) in skill_md_paths.into_iter().enumerate() {
        progress.emit("scanning", i as u32, Some(total), Some(skill_md.clone()));
        let Some((folder, _)) = skill_md.rsplit_once('/') else { continue }; // SKILL.md en la raíz, sin carpeta propia: se ignora
        let Ok(raw) = fetch_raw_github(&client, &owner, &repo, &branch, &skill_md).await else { continue };
        let content = String::from_utf8_lossy(&raw);
        let meta = scan_frontmatter_for_marketplace(&content);
        let folder_name = folder.rsplit('/').next().unwrap_or(folder).to_string();
        let files: Vec<String> = scoped
            .iter()
            .map(|e| e.path.clone())
            .filter(|p| p.starts_with(&format!("{folder}/")))
            .collect();
        out.push(MarketplaceSkillEntry {
            id: folder_name.clone(),
            registry_id: registry_id.to_string(),
            registry_name: registry_name.to_string(),
            name: meta.name.unwrap_or(folder_name),
            description: meta.description,
            categories: meta.categories,
            compatible_agents: meta.compatible_agents,
            folder_path: folder.to_string(),
            files,
            installs: None,
        });
    }
    Ok(out)
}

/// Descarga todos los archivos de una skill remota a una carpeta temporal (preservando
/// su estructura relativa) y reusa el pipeline normal de instalación local — que espera
/// un `SKILL.md` ya en disco — sobre esa copia. La carpeta temporal se borra al terminar,
/// haya salido bien o mal.
async fn install_from_github(
    location: &str,
    entry: &MarketplaceSkillEntry,
    origin: crate::skills::SkillOrigin<'_>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let (owner, repo, branch_opt, _subpath) = parse_github_location(location)?;
    let client = gh_client()?;
    let branch = resolve_branch(&client, &owner, &repo, branch_opt).await?;

    let tmp_root = std::env::temp_dir().join(format!("controlcode-marketplace-{}", Uuid::new_v4()));
    let install_result = async {
        let folder_prefix = format!("{}/", entry.folder_path);
        for file_path in &entry.files {
            let rel = file_path.strip_prefix(&folder_prefix).unwrap_or(file_path);
            let dest = tmp_root.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let bytes = fetch_raw_github(&client, &owner, &repo, &branch, file_path).await?;
            std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
        }

        let skill_md = tmp_root.join("SKILL.md");
        if !skill_md.is_file() {
            return Err("No se encontró SKILL.md tras descargar la carpeta de la skill".to_string());
        }
        install_skill_internal(&skill_md.to_string_lossy(), None, origin, db)
    }
    .await;

    let _ = std::fs::remove_dir_all(&tmp_root);
    install_result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pegar el link del repo tiene que dar exactamente lo mismo que escribirlo a mano en
    /// la forma corta — incluyendo cuando el link viene de estar navegando una subcarpeta.
    #[test]
    fn github_links_normalize_to_the_short_form() {
        let cases = [
            ("anthropics/skills", "anthropics/skills"),
            ("https://github.com/anthropics/skills", "anthropics/skills"),
            ("https://github.com/anthropics/skills/", "anthropics/skills"),
            ("https://github.com/anthropics/skills.git", "anthropics/skills"),
            ("http://github.com/anthropics/skills", "anthropics/skills"),
            ("https://www.github.com/anthropics/skills", "anthropics/skills"),
            ("github.com/anthropics/skills", "anthropics/skills"),
            ("git@github.com:anthropics/skills.git", "anthropics/skills"),
            ("ssh://git@github.com/anthropics/skills", "anthropics/skills"),
            ("  https://github.com/anthropics/skills  ", "anthropics/skills"),
            ("https://github.com/anthropics/skills?tab=readme", "anthropics/skills"),
            ("https://github.com/anthropics/skills#readme", "anthropics/skills"),
            // Navegando dentro del repo: branch y subcarpeta salen de la propia URL.
            ("https://github.com/anthropics/skills/tree/main", "anthropics/skills@main"),
            (
                "https://github.com/anthropics/skills/tree/main/document-skills",
                "anthropics/skills@main:document-skills",
            ),
            (
                "https://github.com/anthropics/skills/blob/v2/examples/nested",
                "anthropics/skills@v2:examples/nested",
            ),
            // La forma corta con branch/subpath se respeta tal cual.
            ("anthropics/skills@main:examples", "anthropics/skills@main:examples"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_github_location(input), expected, "input: {input}");
        }
    }

    #[test]
    fn parse_accepts_links_and_short_form_alike() {
        for input in ["anthropics/skills", "https://github.com/anthropics/skills.git"] {
            let (owner, repo, branch, subpath) = parse_github_location(input).unwrap();
            assert_eq!((owner.as_str(), repo.as_str()), ("anthropics", "skills"));
            assert_eq!(branch, None);
            assert_eq!(subpath, None);
        }

        let (owner, repo, branch, subpath) =
            parse_github_location("https://github.com/anthropics/skills/tree/main/document-skills").unwrap();
        assert_eq!((owner.as_str(), repo.as_str()), ("anthropics", "skills"));
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(subpath.as_deref(), Some("document-skills"));
    }

    /// El filtro por publicador es opcional; vacío significa "todo el directorio" y tiene
    /// que ser un caso válido, no un error.
    #[test]
    fn el_filtro_por_publicador_acepta_vacio_nombre_y_link() {
        for (input, expected) in [
            ("", ""),
            ("   ", ""),
            ("vercel-labs", "vercel-labs"),
            ("Vercel-Labs", "vercel-labs"),
            ("https://skills.sh/vercel-labs", "vercel-labs"),
            ("https://www.skills.sh/vercel-labs/", "vercel-labs"),
            ("https://skills.sh/", ""),
        ] {
            assert_eq!(normalize_owner_filter(input).unwrap(), expected, "input: {input:?}");
        }

        for bad in ["-malo", "malo-", "con espacio", "con_guion_bajo", "a".repeat(40).as_str()] {
            assert!(normalize_owner_filter(bad).is_err(), "debería fallar: {bad:?}");
        }
    }

    /// `folder_path` es lo único que sobrevive en el cache para poder reinstalar después,
    /// así que tiene que quedar en la forma que la CLI entiende tras partirlo.
    #[test]
    fn una_skill_del_directorio_conserva_como_reinstalarse() {
        let hit = skillssh::SkillsShHit {
            id: "vercel-labs/agent-skills/vercel-react-best-practices".into(),
            source: "vercel-labs/agent-skills".into(),
            slug: "vercel-react-best-practices".into(),
            installs: Some("626K".into()),
        };
        let entry = skillssh_entry(hit, "reg-1", "skills.sh");

        assert_eq!(entry.name, "vercel-react-best-practices");
        assert_eq!(entry.registry_id, "reg-1");
        assert_eq!(entry.installs.as_deref(), Some("626K"));
        assert_eq!(
            skillssh::add_target(&entry.folder_path).as_deref(),
            Some("vercel-labs/agent-skills@vercel-react-best-practices")
        );
    }

    /// El campo es nuevo: un `cache_json` escrito por una versión anterior no lo tiene y
    /// tiene que seguir leyéndose, o el marketplace aparecería vacío tras actualizar.
    #[test]
    fn el_cache_viejo_sin_installs_sigue_siendo_legible() {
        let viejo = r#"[{"id":"a","registryId":"r","registryName":"n","name":"A",
            "description":null,"categories":[],"compatibleAgents":[],"folderPath":"a","files":[]}]"#;
        let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(viejo).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].installs, None);
    }

    /// El camino completo de una búsqueda: consultar el directorio, guardar en el cache del
    /// repositorio y poder volver de ahí a una skill instalable.
    ///
    /// Es lo que une los dos lados — sin esto, el parser puede estar bien y el cache quedar
    /// con algo que `install_marketplace_skill` no sabe reinstalar. `#[ignore]` porque
    /// necesita red y Node (ver `skillssh::tests::e2e_…`).
    #[tokio::test]
    #[ignore = "necesita red y Node.js instalado"]
    async fn e2e_buscar_deja_el_cache_listo_para_instalar() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE registries (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                source_type TEXT NOT NULL, location TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1, last_fetched INTEGER, cache_json TEXT,
                cache_error TEXT, created_at INTEGER NOT NULL);
             INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
             VALUES ('r1', 'skills.sh', 'skillssh', '', 0, 1, 0);",
        )
        .unwrap();
        let db: DbConnection = std::sync::Arc::new(std::sync::Mutex::new(conn));

        search_remote_conn(&db, "react testing").await.unwrap();

        let (json, error): (Option<String>, Option<String>) = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT cache_json, cache_error FROM registries WHERE id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(error, None, "la búsqueda no debería dejar error");

        let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(&json.unwrap()).unwrap();
        assert!(!entries.is_empty(), "tiene que haber guardado resultados");
        for e in &entries {
            assert_eq!(e.registry_id, "r1");
            // Lo que `install_marketplace_skill` necesita para poder reinstalarla después.
            assert!(skillssh::add_target(&e.folder_path).is_some(), "no instalable: {}", e.id);
        }

        // Buscar otra cosa REEMPLAZA lo anterior en vez de acumularse: si no, la grilla
        // seguiría mostrando resultados de la búsqueda pasada mezclados con los nuevos.
        // (El buscador del directorio es difuso y casi siempre devuelve algo, así que el
        // caso a cubrir es el reemplazo, no el vacío.)
        let antes: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
        search_remote_conn(&db, "postgres database migrations").await.unwrap();
        let json: Option<String> = {
            let conn = db.lock().unwrap();
            conn.query_row("SELECT cache_json FROM registries WHERE id = 'r1'", [], |r| r.get(0))
                .unwrap()
        };
        let despues: Vec<String> = serde_json::from_str::<Vec<MarketplaceSkillEntry>>(&json.unwrap())
            .unwrap()
            .iter()
            .map(|e| e.id.clone())
            .collect();
        assert_ne!(antes, despues, "el cache tiene que quedar con la búsqueda nueva");
    }

    #[test]
    fn parse_rejects_things_that_are_not_a_repo() {
        for bad in ["", "   ", "anthropics", "/skills", "anthropics/", "https://example.com/foo/bar/baz"] {
            assert!(parse_github_location(bad).is_err(), "debería fallar: {bad:?}");
        }
    }
}
