//! Leer y escribir el frontmatter YAML de un SKILL.md.

use super::types::SkillFrontmatter;

/// Separa el bloque YAML entre las dos primeras líneas `---` del resto del cuerpo del
/// archivo. Si no hay frontmatter (o el YAML es inválido), devuelve metadata vacía y
/// el contenido completo como body — la metadata es opcional, el contenido no lo es.
pub(super) fn split_frontmatter(content: &str) -> (SkillFrontmatter, String) {
    let mut lines = content.lines();
    let Some(first) = lines.next() else { return (SkillFrontmatter::default(), String::new()) };
    if first.trim() != "---" {
        return (SkillFrontmatter::default(), content.to_string());
    }

    let mut yaml_block = String::new();
    let mut found_closing = false;
    for line in lines.by_ref() {
        if line.trim() == "---" {
            found_closing = true;
            break;
        }
        yaml_block.push_str(line);
        yaml_block.push('\n');
    }
    if !found_closing {
        return (SkillFrontmatter::default(), content.to_string());
    }

    let meta: SkillFrontmatter = serde_yaml::from_str(&yaml_block).unwrap_or_default();
    let body: String = lines.collect::<Vec<_>>().join("\n");
    (meta, body)
}

pub(super) fn parse_frontmatter(content: &str) -> SkillFrontmatter {
    split_frontmatter(content).0
}

/// Subconjunto del frontmatter que le sirve a `marketplace` para describir una skill
/// descubierta por auto-scan (sin `registry.json`) sin exponerle el tipo privado
/// `SkillFrontmatter`.
pub(crate) struct ScannedSkillMeta {
    pub name: Option<String>,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub compatible_agents: Vec<String>,
}

pub(crate) fn scan_frontmatter_for_marketplace(content: &str) -> ScannedSkillMeta {
    let meta = parse_frontmatter(content);
    ScannedSkillMeta {
        name: meta.name,
        description: meta.description,
        categories: meta.categories,
        compatible_agents: meta.compatible_agents,
    }
}

/// Reconstruye un SKILL.md completo a partir de metadata + body — usado cuando el
/// usuario completa metadata faltante al instalar (o al editar), para que el archivo
/// en disco quede con el frontmatter final en vez de mantener el original incompleto.
pub(super) fn render_skill_md(meta: &SkillFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
    format!("---\n{yaml}---\n{body}")
}
