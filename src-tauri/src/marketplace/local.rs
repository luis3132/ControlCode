//! Fuente `local` — una carpeta del disco con skills adentro.

use std::path::PathBuf;

use crate::skills::scan_frontmatter_for_marketplace;

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
            if !base.join(&s.path).join("SKILL.md").is_file() {
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
            author: meta.author.clone(),
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
