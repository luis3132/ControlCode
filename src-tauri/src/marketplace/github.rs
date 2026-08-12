//! Fuente `github` — un repositorio público, vía la API de GitHub.
//!
//! Sin autenticación, así que sujeto al rate limit anónimo.

use crate::database::DbConnection;
use crate::skills::{install_skill_internal, scan_frontmatter_for_marketplace, SkillInfo};
use serde::Deserialize;
use uuid::Uuid;

use super::types::{MarketplaceSkillEntry, ProgressReporter, RegistryManifest};

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
pub(super) fn normalize_github_location(input: &str) -> String {
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
pub(super) fn parse_github_location(
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

/// Rama por defecto del repo, para poder listar su árbol sin que el usuario la escriba.
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

pub(super) async fn fetch_github_registry(
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
pub(super) async fn install_from_github(
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
