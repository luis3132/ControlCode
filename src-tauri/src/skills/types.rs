//! Los tipos de una skill: lo que se guarda, lo que viaja al frontend y su frontmatter.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsageEntry {
    pub workspace_id: String,
    pub workspace_name: String,
    pub scope: String,
    pub tab_id: Option<String>,
    pub tab_title: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: String,
    pub categories: Vec<String>,
    pub compatible_agents: Vec<String>,
    pub compatible_versions: HashMap<String, String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub homepage: Option<String>,
    pub source_path: String,
    /// Repo del que salió. `None` = instalada a mano desde un archivo local.
    pub registry_id: Option<String>,
    /// Nombre del repo tal como se llamaba al instalar — desnormalizado para que el badge
    /// siga siendo correcto aunque el repositorio se borre después.
    pub registry_name: Option<String>,
    /// Entrada del repositorio de la que salió. Con `registry_id` forma la identidad
    /// exacta del origen — el nombre NO identifica: dos skills homónimas pueden ser de
    /// autores distintos, incluso dentro del mismo repositorio (ver `SkillOrigin`).
    pub origin_skill_id: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillWithUsage {
    #[serde(flatten)]
    pub skill: SkillInfo,
    pub used_by: Vec<SkillUsageEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub skill: SkillInfo,
    pub content: String,
}

/// Frontmatter YAML de SKILL.md (`---\n...\n---`). Todos los campos son opcionales:
/// una skill sin frontmatter (o con YAML inválido) igual debe poder instalarse,
/// usando el nombre de la carpeta como fallback y defaults vacíos para el resto.
/// También implementa `Serialize` (con campos vacíos omitidos) para poder reescribir
/// el bloque de frontmatter cuando el usuario completa metadata faltante al instalar.
#[derive(Deserialize, Serialize, Default, Debug, Clone)]
#[serde(default)]
pub(super) struct SkillFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) categories: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) compatible_agents: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub(super) compatible_versions: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) homepage: Option<String>,
}

/// Campos de metadata "sugeridos" que faltan en el frontmatter parseado — el frontend
/// usa esta lista para decidir qué inputs mostrarle al usuario al instalar una skill
/// incompleta (name no cuenta: siempre tiene fallback al nombre de la carpeta).
pub(super) fn missing_fields(meta: &SkillFrontmatter) -> Vec<String> {
    let mut missing = Vec::new();
    if meta.description.is_none() { missing.push("description".to_string()); }
    if meta.version.is_none() { missing.push("version".to_string()); }
    if meta.categories.is_empty() { missing.push("categories".to_string()); }
    if meta.compatible_agents.is_empty() { missing.push("compatibleAgents".to_string()); }
    if meta.author.is_none() { missing.push("author".to_string()); }
    if meta.license.is_none() { missing.push("license".to_string()); }
    if meta.homepage.is_none() { missing.push("homepage".to_string()); }
    missing
}

/// Forma que cruza el límite de Tauri IPC (camelCase, JS-friendly) para: (a) la
/// respuesta de `preview_skill_metadata` y (b) los overrides que `install_skill`
/// recibe cuando el usuario completó metadata faltante en el formulario de instalación.
/// Separado de `SkillFrontmatter` (que usa snake_case porque así vienen las claves YAML).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillFrontmatterInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub categories: Vec<String>,
    pub compatible_agents: Vec<String>,
    pub compatible_versions: HashMap<String, String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub homepage: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreview {
    pub meta: SkillFrontmatterInput,
    /// Nombre de carpeta, para que el frontend lo muestre como fallback de `name`.
    pub folder_name: String,
    /// Subconjunto de `SUGGESTED_FIELDS` que no vino en el frontmatter original.
    pub missing: Vec<String>,
}

impl From<SkillFrontmatter> for SkillFrontmatterInput {
    fn from(m: SkillFrontmatter) -> Self {
        SkillFrontmatterInput {
            name: m.name,
            description: m.description,
            version: m.version,
            categories: m.categories,
            compatible_agents: m.compatible_agents,
            compatible_versions: m.compatible_versions,
            author: m.author,
            license: m.license,
            homepage: m.homepage,
        }
    }
}

impl From<SkillFrontmatterInput> for SkillFrontmatter {
    fn from(i: SkillFrontmatterInput) -> Self {
        SkillFrontmatter {
            name: i.name,
            description: i.description,
            version: i.version,
            categories: i.categories,
            compatible_agents: i.compatible_agents,
            compatible_versions: i.compatible_versions,
            author: i.author,
            license: i.license,
            homepage: i.homepage,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkHealthEntry {
    /// Qué skill exactamente. El nombre no alcanza para volver a encontrarla: dos
    /// instaladas pueden llamarse igual y ser de autores distintos, así que la UI linkeaba
    /// el aviso a la que encontrara primero.
    pub skill_id: String,
    pub skill_name: String,
    pub tab_id: String,
    pub tab_title: Option<String>,
    pub link_path: String,
    pub issue: String, // "missing" | "broken" | "stale_target"
}

/// Dónde volver a bajar una skill que ya no está instalada.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub registry_id: String,
    pub registry_name: String,
    /// Id de la skill DENTRO de ese registry (no el id de la copia instalada).
    pub marketplace_skill_id: String,
}

/// Estado de una de las skills que tenía una sesión al cerrarse.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkillStatus {
    pub name: String,
    pub scope: String,
    /// Id de la copia instalada que la cubre hoy — puede diferir del archivado si el
    /// usuario la borró y la reinstaló (misma skill, id nuevo).
    ///
    /// `None` = ya no está instalada, o hay varias homónimas y no se eligió ninguna
    /// (ver `ambiguous`).
    pub installed_skill_id: Option<String>,
    /// La copia EXACTA que tenía la sesión ya no está y se resolvió con otra del mismo
    /// nombre. Se avisa igual: puede ser de otro autor y hacer otra cosa.
    pub substituted: bool,
    /// La copia exacta no está y hay VARIAS instaladas con ese nombre, así que no se
    /// eligió ninguna — elegir al azar le montaría a la sesión una skill que nunca tuvo.
    pub ambiguous: bool,
    /// Si falta: de dónde se puede volver a bajar, si algún repo habilitado la ofrece.
    pub available_from: Option<SkillSource>,
}

impl SessionSkillStatus {
    pub(super) fn is_missing(&self) -> bool {
        self.installed_skill_id.is_none()
    }
}
