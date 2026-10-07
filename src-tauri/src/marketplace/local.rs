//! Fuente `local` — una carpeta del disco con skills adentro.

use std::path::PathBuf;

use crate::skills::{scan_frontmatter_for_marketplace, skill_markdown};

use super::types::{MarketplaceSkillEntry, ProgressReporter, RegistryManifest};

pub(super) fn scan_local_registry(
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
            // La entrada puede ser una carpeta (con su SKILL.md, o el .md que tenga) o un
            // .md suelto.
            if skill_markdown(&base.join(&s.path)).is_none() {
                continue; // declarada en el manifest pero ausente en disco, se saltea
            }
            let id = s.id.clone().unwrap_or_else(|| s.path.clone());
            out.push(MarketplaceSkillEntry {
                id,
                registry_id: registry_id.to_string(),
                registry_name: registry_name.to_string(),
                name: s.name.unwrap_or_else(|| s.path.clone()),
                author: s.author,
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

    // Sin manifest: cada subcarpeta directa con un markdown de skill adentro (su SKILL.md,
    // o el .md que tenga) es una skill, y también cada `.md` suelto de la raíz
    // (`facturas-crear.md`), salvo los que documentan la carpeta misma.
    const NOT_SKILLS: &[&str] = &["readme.md", "changelog.md", "contributing.md", "license.md"];
    let mut out = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&base)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            p.is_dir() || (p.is_file() && name.ends_with(".md") && !NOT_SKILLS.contains(&name.as_str()))
        })
        .collect();
    entries.sort();
    let total = entries.len() as u32;
    for (i, path) in entries.into_iter().enumerate() {
        let entry_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        progress.emit("scanning", i as u32, Some(total), Some(entry_name.clone()));
        let Some(markdown) = skill_markdown(&path) else { continue };
        let Ok(content) = std::fs::read_to_string(&markdown) else { continue };
        let meta = scan_frontmatter_for_marketplace(&content);
        // El nombre de una suelta es el del archivo sin `.md`; el de una carpeta, el suyo.
        let default_name = if path.is_dir() {
            entry_name.clone()
        } else {
            path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| entry_name.clone())
        };
        out.push(MarketplaceSkillEntry {
            id: default_name.clone(),
            registry_id: registry_id.to_string(),
            registry_name: registry_name.to_string(),
            name: meta.name.unwrap_or_else(|| default_name.clone()),
            author: meta.author.clone(),
            description: meta.description,
            categories: meta.categories,
            compatible_agents: meta.compatible_agents,
            // La ruta de la entrada tal cual (carpeta o archivo): instalar la resuelve.
            folder_path: entry_name,
            files: Vec::new(),
            installs: None,
        });
    }
    Ok(out)
}
