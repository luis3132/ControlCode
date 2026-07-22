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
//! Fuentes soportadas en esta fase: `local` (carpeta en disco) y `github` (repo público,
//! vía la API de GitHub — sin autenticación, sujeto a su rate limit anónimo). "URL con
//! manifest JSON" genérica y "git genérico" (clonar cualquier remoto) quedan pendientes
//! del plan original: requieren descubrir el listado de archivos de un servidor HTTP
//! arbitrario (no hay una API estándar para eso) y traer un cliente git embebido
//! respectivamente — ninguna de las dos es segura de improvisar sin poder probarla
//! contra una fuente real.

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

#[tauri::command]
pub async fn add_registry(
    name: String,
    source_type: String,
    location: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<RegistrySummary, String> {
    if source_type != "local" && source_type != "github" {
        return Err(format!(
            "Tipo de registry no soportado todavía: {source_type} (solo 'local' o 'github')"
        ));
    }
    let id = Uuid::new_v4().to_string();
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
    refresh_registry_internal(&id, &db).await
}

#[tauri::command]
pub fn remove_registry(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM registries WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
) -> Result<RegistrySummary, String> {
    refresh_registry_internal(&id, &db).await
}

/// Vuelve a resolver la lista de skills de un registry (fetch de red para `github`, scan
/// de filesystem para `local`) y cachea el resultado en `cache_json`. Nunca mantiene el
/// lock de SQLite durante el `.await` de red: lee los datos de la fila, suelta el lock,
/// hace el trabajo async, y vuelve a tomar el lock (corto) solo para escribir el resultado.
async fn refresh_registry_internal(
    id: &str,
    db: &DbConnection,
) -> Result<RegistrySummary, String> {
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
        "local" => scan_local_registry(id, &name, &location),
        "github" => fetch_github_registry(id, &name, &location).await,
        other => Err(format!("Tipo de registry desconocido: {other}")),
    };

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
        .prepare("SELECT cache_json FROM registries WHERE enabled = 1 ORDER BY priority ASC")
        .map_err(|e| e.to_string())?;
    let cached: Vec<Option<String>> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let query_lower = query.as_deref().map(|q| q.to_lowercase());
    let mut out = Vec::new();
    for json in cached.into_iter().flatten() {
        let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(&json).unwrap_or_default();
        for entry in entries {
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
    let (source_type, location, entries) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let (source_type, location, cache_json): (String, String, Option<String>) = conn
            .query_row(
                "SELECT source_type, location, cache_json FROM registries WHERE id = ?1",
                [&registry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "Registry no encontrado".to_string())?;
        let entries: Vec<MarketplaceSkillEntry> = cache_json
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        (source_type, location, entries)
    };

    let entry = entries
        .into_iter()
        .find(|e| e.id == skill_id)
        .ok_or_else(|| "Esta skill ya no está en el registry (probá refrescarlo)".to_string())?;

    match source_type.as_str() {
        "local" => {
            let file = PathBuf::from(&location).join(&entry.folder_path).join("SKILL.md");
            install_skill_internal(&file.to_string_lossy(), None, &db)
        }
        "github" => install_from_github(&location, &entry, &db).await,
        other => Err(format!("Tipo de registry desconocido: {other}")),
    }
}

// ── Fuente: carpeta local ────────────────────────────────────────

fn scan_local_registry(
    registry_id: &str,
    registry_name: &str,
    location: &str,
) -> Result<Vec<MarketplaceSkillEntry>, String> {
    let base = PathBuf::from(location);
    if !base.is_dir() {
        return Err(format!("{location} no es una carpeta accesible"));
    }

    let manifest_path = base.join("registry.json");
    if manifest_path.is_file() {
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let manifest: RegistryManifest =
            serde_json::from_str(&raw).map_err(|e| format!("registry.json inválido: {e}"))?;
        let mut out = Vec::new();
        for s in manifest.skills {
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
            });
        }
        return Ok(out);
    }

    // Sin manifest: cada subcarpeta directa con un SKILL.md adentro es una skill (mismo
    // criterio "Scan automático" que el plan pide para repos sin manifest formal).
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
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
        });
    }
    Ok(out)
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

/// Parsea `owner/repo[@branch][:subpath]` — ej. `anthropics/skills`,
/// `anthropics/skills@main:examples`.
fn parse_github_location(
    location: &str,
) -> Result<(String, String, Option<String>, Option<String>), String> {
    let (repo_part, subpath) = match location.split_once(':') {
        Some((r, p)) => (r, Some(p.trim_start_matches('/').trim_end_matches('/').to_string())),
        None => (location, None),
    };
    let (owner_repo, branch) = match repo_part.split_once('@') {
        Some((r, b)) => (r, Some(b.to_string())),
        None => (repo_part, None),
    };
    let mut parts = owner_repo.splitn(2, '/');
    let owner = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Formato esperado: owner/repo".to_string())?;
    let repo = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Formato esperado: owner/repo".to_string())?;
    Ok((owner.to_string(), repo.to_string(), branch, subpath))
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
) -> Result<Vec<MarketplaceSkillEntry>, String> {
    let (owner, repo, branch_opt, subpath) = parse_github_location(location)?;
    let client = gh_client()?;
    let branch = resolve_branch(&client, &owner, &repo, branch_opt).await?;

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

        let mut out = Vec::new();
        for s in manifest.skills {
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

    let mut out = Vec::new();
    for skill_md in skill_md_paths {
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
        install_skill_internal(&skill_md.to_string_lossy(), None, db)
    }
    .await;

    let _ = std::fs::remove_dir_all(&tmp_root);
    install_result
}
