use crate::database::DbConnection;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
struct SkillFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    categories: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    compatible_agents: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    compatible_versions: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
}

/// Campos de metadata "sugeridos" que faltan en el frontmatter parseado — el frontend
/// usa esta lista para decidir qué inputs mostrarle al usuario al instalar una skill
/// incompleta (name no cuenta: siempre tiene fallback al nombre de la carpeta).
fn missing_fields(meta: &SkillFrontmatter) -> Vec<String> {
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

// ── Frontmatter parsing ──────────────────────────────────────────

/// Separa el bloque YAML entre las dos primeras líneas `---` del resto del cuerpo del
/// archivo. Si no hay frontmatter (o el YAML es inválido), devuelve metadata vacía y
/// el contenido completo como body — la metadata es opcional, el contenido no lo es.
fn split_frontmatter(content: &str) -> (SkillFrontmatter, String) {
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

fn parse_frontmatter(content: &str) -> SkillFrontmatter {
    split_frontmatter(content).0
}

/// Reconstruye un SKILL.md completo a partir de metadata + body — usado cuando el
/// usuario completa metadata faltante al instalar (o al editar), para que el archivo
/// en disco quede con el frontmatter final en vez de mantener el original incompleto.
fn render_skill_md(meta: &SkillFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
    format!("---\n{yaml}---\n{body}")
}

/// Valida que `source_file` sea un `SKILL.md` real y devuelve `(archivo, carpeta que lo
/// contiene)` — la carpeta es la que se termina copiando entera al instalar, porque una
/// skill suele traer archivos de soporte junto al SKILL.md (scripts, assets, etc.), pero
/// el usuario elige explícitamente el archivo, no la carpeta.
fn resolve_skill_file(source_file: &str) -> Result<(PathBuf, PathBuf), String> {
    let file = PathBuf::from(source_file);
    let is_skill_md = file
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("SKILL.md"))
        .unwrap_or(false);
    if !is_skill_md {
        return Err("Selecciona un archivo SKILL.md".to_string());
    }
    if !file.is_file() {
        return Err(format!("No se encontró el archivo {source_file}"));
    }
    let folder = file
        .parent()
        .ok_or_else(|| "No se pudo determinar la carpeta del archivo".to_string())?
        .to_path_buf();
    Ok((file, folder))
}

/// Lee un SKILL.md y devuelve su frontmatter parseado + contenido crudo, o `None` si
/// el archivo no se puede leer.
fn scan_skill_file(file: &Path) -> Option<(SkillFrontmatter, String)> {
    let content = std::fs::read_to_string(file).ok()?;
    let meta = parse_frontmatter(&content);
    Some((meta, content))
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "skill".to_string() } else { slug }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest_path)?;
        }
        // symlinks dentro de la carpeta fuente se ignoran deliberadamente: no tiene
        // sentido copiar un symlink a la copia global, podría apuntar fuera de ella.
    }
    Ok(())
}

// ── Settings: directorio global de skills ────────────────────────

fn resolve_skills_dir(db: &DbConnection) -> Result<PathBuf, String> {
    let value = crate::database::get_setting(db, "skills_dir")?;
    let dir = match value {
        Some(v) => PathBuf::from(v),
        None => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            home.join(".controlcode").join("skills")
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ── Row <-> struct mapping ────────────────────────────────────────

fn row_to_skill_info(row: &rusqlite::Row) -> rusqlite::Result<SkillInfo> {
    let categories_json: String = row.get(3)?;
    let compatible_agents_json: String = row.get(4)?;
    let compatible_versions_json: String = row.get(5)?;
    Ok(SkillInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        categories: serde_json::from_str(&categories_json).unwrap_or_default(),
        compatible_agents: serde_json::from_str(&compatible_agents_json).unwrap_or_default(),
        compatible_versions: serde_json::from_str(&compatible_versions_json).unwrap_or_default(),
        version: row.get(6)?,
        author: row.get(7)?,
        license: row.get(8)?,
        homepage: row.get(9)?,
        source_path: row.get(10)?,
        installed_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const SKILL_COLUMNS: &str = "id, name, description, categories, compatible_agents, compatible_versions, version, author, license, homepage, source_path, installed_at, updated_at";

// ── Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn get_skills_dir(db: tauri::State<DbConnection>) -> Result<String, String> {
    let dir = resolve_skills_dir(&db)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_skills_dir(path: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    crate::database::db_set_setting("skills_dir".to_string(), path, db)
}

/// Lee el SKILL.md elegido y devuelve su metadata parseada más la lista de campos
/// "sugeridos" que no vinieron en el frontmatter — el frontend usa `missing` para
/// decidir si mostrar un formulario de metadata antes de instalar.
#[tauri::command]
pub fn preview_skill_metadata(source_file: String) -> Result<SkillPreview, String> {
    let (file, folder) = resolve_skill_file(&source_file)?;
    let Some((meta, _content)) = scan_skill_file(&file) else {
        return Err(format!("No se pudo leer {source_file}"));
    };
    let folder_name = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let missing = missing_fields(&meta);
    Ok(SkillPreview { meta: meta.into(), folder_name, missing })
}

#[tauri::command]
pub fn install_skill(
    source_file: String,
    overrides: Option<SkillFrontmatterInput>,
    db: tauri::State<DbConnection>,
) -> Result<SkillInfo, String> {
    let (file, source) = resolve_skill_file(&source_file)?;
    let Some((parsed_meta, original_content)) = scan_skill_file(&file) else {
        return Err(format!("No se pudo leer {source_file}"));
    };

    // Si el usuario completó metadata faltante en el formulario de instalación, esos
    // valores reemplazan el frontmatter original al completo (el frontend siempre manda
    // el objeto ya fusionado: lo que vino del archivo + lo que el usuario tipeó).
    let meta: SkillFrontmatter = match overrides {
        Some(o) => o.into(),
        None => parsed_meta,
    };

    let folder_basename = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let name = meta.name.clone().unwrap_or(folder_basename);

    let skills_dir = resolve_skills_dir(&db)?;
    let mut slug = slugify(&name);
    let mut dest = skills_dir.join(&slug);
    let mut suffix = 1;
    while dest.exists() {
        suffix += 1;
        slug = format!("{}-{}", slugify(&name), suffix);
        dest = skills_dir.join(&slug);
    }

    copy_dir_recursive(&source, &dest).map_err(|e| e.to_string())?;

    // Si se completó metadata (o simplemente para normalizar), reescribimos SKILL.md en
    // la copia global con el frontmatter final — "guardar el archivo modificado" pedido
    // por el usuario. El body (contenido debajo del frontmatter) se preserva intacto.
    let (_, body) = split_frontmatter(&original_content);
    let mut meta_to_write = meta.clone();
    meta_to_write.name = Some(name.clone());
    let final_content = render_skill_md(&meta_to_write, &body);
    std::fs::write(dest.join("SKILL.md"), &final_content).map_err(|e| e.to_string())?;

    let now = now_ts();
    let id = Uuid::new_v4().to_string();
    let info = SkillInfo {
        id: id.clone(),
        name,
        description: meta.description,
        version: meta.version.unwrap_or_else(|| "0.1.0".to_string()),
        categories: meta.categories,
        compatible_agents: meta.compatible_agents,
        compatible_versions: meta.compatible_versions,
        author: meta.author,
        license: meta.license,
        homepage: meta.homepage,
        source_path: dest.to_string_lossy().to_string(),
        installed_at: now,
        updated_at: now,
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO skills (id, name, description, version, categories, compatible_agents, compatible_versions, author, license, homepage, source_path, installed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        rusqlite::params![
            info.id,
            info.name,
            info.description,
            info.version,
            serde_json::to_string(&info.categories).unwrap_or_default(),
            serde_json::to_string(&info.compatible_agents).unwrap_or_default(),
            serde_json::to_string(&info.compatible_versions).unwrap_or_default(),
            info.author,
            info.license,
            info.homepage,
            info.source_path,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(info)
}

fn fetch_usage_for_skill(conn: &rusqlite::Connection, skill_id: &str) -> Result<Vec<SkillUsageEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ps.workspace_id, w.name, ps.scope, ps.tab_id, t.title
             FROM project_skills ps
             JOIN workspaces w ON w.id = ps.workspace_id
             LEFT JOIN tabs t ON t.id = ps.tab_id
             WHERE ps.skill_id = ?1 AND ps.enabled = 1",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([skill_id], |row| {
            Ok(SkillUsageEntry {
                workspace_id: row.get(0)?,
                workspace_name: row.get(1)?,
                scope: row.get(2)?,
                tab_id: row.get(3)?,
                tab_title: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn list_skills(db: tauri::State<DbConnection>) -> Result<Vec<SkillWithUsage>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let query = format!("SELECT {SKILL_COLUMNS} FROM skills ORDER BY name ASC");
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let skills: Vec<SkillInfo> = stmt
        .query_map([], row_to_skill_info)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut result = Vec::with_capacity(skills.len());
    for skill in skills {
        let used_by = fetch_usage_for_skill(&conn, &skill.id)?;
        result.push(SkillWithUsage { skill, used_by });
    }
    Ok(result)
}

#[tauri::command]
pub fn list_skill_usage(skill_id: String, db: tauri::State<DbConnection>) -> Result<Vec<SkillUsageEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    fetch_usage_for_skill(&conn, &skill_id)
}

#[tauri::command]
pub fn get_skill_detail(skill_id: String, db: tauri::State<DbConnection>) -> Result<SkillDetail, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let query = format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?1");
    let skill = conn
        .query_row(&query, [&skill_id], row_to_skill_info)
        .map_err(|e| e.to_string())?;
    drop(conn);

    let content = std::fs::read_to_string(Path::new(&skill.source_path).join("SKILL.md"))
        .map_err(|e| e.to_string())?;

    Ok(SkillDetail { skill, content })
}

#[tauri::command]
pub fn update_skill_content(
    skill_id: String,
    content: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let source_path: String = conn
        .query_row("SELECT source_path FROM skills WHERE id = ?1", [&skill_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    std::fs::write(Path::new(&source_path).join("SKILL.md"), &content).map_err(|e| e.to_string())?;

    let meta = parse_frontmatter(&content);
    let now = now_ts();
    conn.execute(
        "UPDATE skills SET name = COALESCE(?1, name), description = ?2, version = ?3,
             categories = ?4, compatible_agents = ?5, compatible_versions = ?6,
             author = ?7, license = ?8, homepage = ?9, updated_at = ?10
         WHERE id = ?11",
        rusqlite::params![
            meta.name,
            meta.description,
            meta.version.unwrap_or_else(|| "0.1.0".to_string()),
            serde_json::to_string(&meta.categories).unwrap_or_default(),
            serde_json::to_string(&meta.compatible_agents).unwrap_or_default(),
            serde_json::to_string(&meta.compatible_versions).unwrap_or_default(),
            meta.author,
            meta.license,
            meta.homepage,
            now,
            skill_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Todas las tabs (cwd, agent_id) que deberían tener un symlink físico de `skill_id`,
/// resolviendo attachments de scope='tab' (una tab puntual) y scope='workspace'
/// (todas las tabs del workspace en ese momento) a filas concretas de `tabs`.
fn collect_linked_tabs(conn: &rusqlite::Connection, skill_id: &str) -> Result<Vec<(String, String)>, String> {
    let attachments: Vec<(Option<String>, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT tab_id, scope, workspace_id FROM project_skills WHERE skill_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([skill_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut result = Vec::new();
    for (tab_id, scope, workspace_id) in attachments {
        if scope == "tab" {
            if let Some(tab_id) = tab_id {
                let row: Option<(String, String)> = conn
                    .query_row("SELECT cwd, agent_id FROM tabs WHERE id = ?1", [&tab_id], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .optional()
                    .map_err(|e| e.to_string())?;
                if let Some(pair) = row {
                    result.push(pair);
                }
            }
        } else {
            let rows: Vec<(String, String)> = {
                let mut wstmt = conn
                    .prepare("SELECT t.cwd, t.agent_id FROM tabs t JOIN windows w ON w.id = t.window_id WHERE w.workspace_id = ?1")
                    .map_err(|e| e.to_string())?;
                let it = wstmt
                    .query_map([&workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map_err(|e| e.to_string())?;
                it.filter_map(|r| r.ok()).collect()
            };
            result.extend(rows);
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn delete_skill(skill_id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let source_path: String = conn
        .query_row("SELECT source_path FROM skills WHERE id = ?1", [&skill_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    // Remover symlinks físicos de cada attachment antes de borrar la fila (el cascade
    // de la FK solo limpia la DB, no el filesystem). Best-effort: un symlink ya roto o
    // ya removido manualmente no debe bloquear el borrado de la skill.
    let slug = slug_from_source_path(&source_path);
    for (cwd, agent_id) in collect_linked_tabs(&conn, &skill_id)? {
        if let Some(link_path) = link_path_for(&cwd, &agent_id, &slug) {
            remove_symlink_best_effort(&link_path);
        }
    }

    conn.execute("DELETE FROM skills WHERE id = ?1", [&skill_id]).map_err(|e| e.to_string())?;
    drop(conn);

    let _ = std::fs::remove_dir_all(&source_path);

    Ok(())
}

fn slug_from_source_path(source_path: &str) -> String {
    Path::new(source_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Remueve un symlink si existe, ignorando errores (ya borrado a mano, roto, etc.) —
/// usado por delete_skill/detach_skill, donde una limpieza a medias no debe bloquear
/// el resto de la operación.
fn remove_symlink_best_effort(path: &Path) {
    if path.symlink_metadata().is_ok() {
        let _ = symlink::remove_symlink_auto(path);
    }
}

/// Convención de path del symlink dentro del cwd de una tab, según el agente. Solo
/// Claude Code tiene una convención de discovery de skills confirmada; para el resto
/// no se symlinkea nada todavía (devuelve `None`) hasta verificar si tienen un
/// mecanismo equivalente.
/// TODO: verificar convención real de skills para gemini-cli/codex/opencode.
pub fn link_path_for(cwd: &str, agent_id: &str, slug: &str) -> Option<PathBuf> {
    match agent_id {
        "claude-code" => Some(Path::new(cwd).join(".claude").join("skills").join(slug)),
        _ => None,
    }
}

// ── Attach / detach (symlinks) ────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkHealthEntry {
    pub skill_name: String,
    pub tab_id: String,
    pub tab_title: Option<String>,
    pub link_path: String,
    pub issue: String, // "missing" | "broken" | "stale_target"
}

fn fetch_skill_row(conn: &rusqlite::Connection, skill_id: &str) -> Result<SkillInfo, String> {
    let query = format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?1");
    conn.query_row(&query, [skill_id], row_to_skill_info).map_err(|e| e.to_string())
}

/// Tabs (id, cwd, agent_id) de un workspace, o de una sola tab puntual si `tab_id` está
/// presente. Usado por attach/detach/health-check para resolver a qué tabs concretas
/// aplica un `project_skills` row, sin duplicar la lógica de scope en cada comando.
fn tabs_for_scope(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    tab_id: Option<&str>,
) -> Result<Vec<(String, String, String)>, String> {
    if let Some(tab_id) = tab_id {
        let row: Option<(String, String, String)> = conn
            .query_row("SELECT id, cwd, agent_id FROM tabs WHERE id = ?1", [tab_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.into_iter().collect())
    } else {
        let mut stmt = conn
            .prepare("SELECT t.id, t.cwd, t.agent_id FROM tabs t JOIN windows w ON w.id = t.window_id WHERE w.workspace_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

/// Crea (idempotente) el symlink de `skill` en el cwd de una tab. No-op si ya apunta al
/// `source_path` correcto; reemplaza si apunta a otro lado; error claro si el destino
/// existe y no es un symlink (evita pisar un directorio/archivo real del usuario).
fn ensure_symlink(skill: &SkillInfo, cwd: &str, agent_id: &str) -> Result<(), String> {
    if !skill.compatible_agents.is_empty() && !skill.compatible_agents.iter().any(|a| a == agent_id) {
        return Ok(()); // skill no aplica a este agente, no es un error
    }
    let slug = slug_from_source_path(&skill.source_path);
    let Some(link_path) = link_path_for(cwd, agent_id, &slug) else {
        return Ok(()); // agente sin convención de skills confirmada todavía, se saltea
    };

    if let Ok(meta) = link_path.symlink_metadata() {
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&link_path).map_err(|e| e.to_string())?;
            if target == Path::new(&skill.source_path) {
                return Ok(()); // ya apunta donde debe
            }
            remove_symlink_best_effort(&link_path);
        } else {
            return Err(format!(
                "{} ya existe y no es un symlink. Resolvé el conflicto manualmente antes de attachear la skill.",
                link_path.display()
            ));
        }
    }

    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    symlink::symlink_dir(&skill.source_path, &link_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn attach_skill(
    skill_id: String,
    workspace_id: String,
    scope: String,
    tab_id: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    if scope == "tab" && tab_id.is_none() {
        return Err("scope='tab' requiere tab_id".to_string());
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    let skill = fetch_skill_row(&conn, &skill_id)?;
    let tabs = tabs_for_scope(&conn, &workspace_id, tab_id.as_deref())?;

    for (_, cwd, agent_id) in &tabs {
        ensure_symlink(&skill, cwd, agent_id)?;
    }

    let now = now_ts();
    conn.execute(
        "INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(skill_id, workspace_id, scope, tab_id) DO UPDATE SET enabled = 1",
        rusqlite::params![Uuid::new_v4().to_string(), skill_id, workspace_id, scope, tab_id, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn detach_skill(
    skill_id: String,
    workspace_id: String,
    scope: String,
    tab_id: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let skill = fetch_skill_row(&conn, &skill_id)?;
    let tabs = tabs_for_scope(&conn, &workspace_id, tab_id.as_deref())?;
    let slug = slug_from_source_path(&skill.source_path);

    for (_, cwd, agent_id) in &tabs {
        if let Some(link_path) = link_path_for(cwd, agent_id, &slug) {
            remove_symlink_best_effort(&link_path);
        }
    }

    conn.execute(
        "DELETE FROM project_skills WHERE skill_id = ?1 AND workspace_id = ?2 AND scope = ?3
         AND ((tab_id IS NULL AND ?4 IS NULL) OR tab_id = ?4)",
        rusqlite::params![skill_id, workspace_id, scope, tab_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Recrea los symlinks de todas las skills attacheadas a nivel workspace contra el set
/// actual de tabs de ese workspace — usado tras crear una tab nueva, para que herede
/// automáticamente las skills de scope='workspace' ya activas (best-effort: una tab con
/// un agente incompatible o sin convención de skills confirmada simplemente se saltea).
#[tauri::command]
pub fn sync_workspace_skills(workspace_id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let skill_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT skill_id FROM project_skills WHERE workspace_id = ?1 AND scope = 'workspace' AND enabled = 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let tabs = tabs_for_scope(&conn, &workspace_id, None)?;
    for skill_id in skill_ids {
        let skill = fetch_skill_row(&conn, &skill_id)?;
        for (_, cwd, agent_id) in &tabs {
            // Best-effort: una tab con conflicto de symlink no debe bloquear el resto.
            let _ = ensure_symlink(&skill, cwd, agent_id);
        }
    }

    Ok(())
}

/// Verifica, para cada attachment habilitado de un workspace, que el symlink físico
/// exista y apunte al `source_path` correcto. Solo devuelve entradas con problema —
/// una skill sana no aparece en el resultado.
#[tauri::command]
pub fn check_symlinks_health(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<SymlinkHealthEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let attachments: Vec<(String, String, String, Option<String>)> = {
        let mut stmt = conn
            .prepare("SELECT skill_id, scope, id, tab_id FROM project_skills WHERE workspace_id = ?1 AND enabled = 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut issues = Vec::new();
    for (skill_id, _scope, project_skill_id, scoped_tab_id) in attachments {
        let skill = fetch_skill_row(&conn, &skill_id)?;
        let slug = slug_from_source_path(&skill.source_path);
        let tabs = tabs_for_scope(&conn, &workspace_id, scoped_tab_id.as_deref())?;
        let _ = project_skill_id;

        for (tab_id, cwd, agent_id) in tabs {
            if !skill.compatible_agents.is_empty() && !skill.compatible_agents.iter().any(|a| a == &agent_id) {
                continue;
            }
            let Some(link_path) = link_path_for(&cwd, &agent_id, &slug) else { continue };

            let title: Option<String> = conn
                .query_row("SELECT title FROM tabs WHERE id = ?1", [&tab_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();

            let issue = match link_path.symlink_metadata() {
                Err(_) => Some("missing"),
                Ok(meta) if !meta.file_type().is_symlink() => Some("stale_target"),
                Ok(_) => match std::fs::read_link(&link_path) {
                    Err(_) => Some("broken"),
                    Ok(target) if target != Path::new(&skill.source_path) => Some("stale_target"),
                    Ok(_) => None,
                },
            };

            if let Some(issue) = issue {
                issues.push(SymlinkHealthEntry {
                    skill_name: skill.name.clone(),
                    tab_id,
                    tab_title: title,
                    link_path: link_path.to_string_lossy().to_string(),
                    issue: issue.to_string(),
                });
            }
        }
    }

    Ok(issues)
}

// ── Integration test: ejercita el módulo real contra SQLite + filesystem reales,
// sin tocar la DB del usuario (`~/.controlcode/data.db`). Usa `tauri::test::mock_app`
// para obtener un `tauri::State<DbConnection>` legítimo (no se puede construir a mano,
// el campo es privado) y así llamar los comandos tal cual los llamaría el frontend.
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tauri::Manager;

    const TEST_SCHEMA: &str = "
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
        CREATE TABLE windows (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, pos_x INTEGER, pos_y INTEGER, width INTEGER, height INTEGER, monitor TEXT, is_open INTEGER NOT NULL DEFAULT 1, last_active INTEGER NOT NULL);
        CREATE TABLE tabs (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, title TEXT, title_is_custom INTEGER NOT NULL DEFAULT 0, agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, tab_order INTEGER NOT NULL DEFAULT 0, session_id TEXT, scrollback TEXT, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
        CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, version TEXT NOT NULL DEFAULT '0.1.0', categories TEXT NOT NULL DEFAULT '[]', compatible_agents TEXT NOT NULL DEFAULT '[]', compatible_versions TEXT NOT NULL DEFAULT '{}', author TEXT, license TEXT, homepage TEXT, source_path TEXT NOT NULL UNIQUE, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE project_skills (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'workspace', tab_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE (skill_id, workspace_id, scope, tab_id));
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ";

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-skills-test-{}-{}", label, Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Arma una DB de prueba con un workspace + una tab (agent_id='claude-code') cuyo
    /// cwd es una carpeta temporal real, más el setting skills_dir apuntando a otra
    /// carpeta temporal — replica el estado mínimo que attach_skill necesita.
    fn setup() -> (DbConnection, String, String, PathBuf, PathBuf) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_SCHEMA).unwrap();

        let workspace_id = "ws-test".to_string();
        let window_id = "win-test".to_string();
        let tab_id = "tab-test".to_string();
        let tab_cwd = temp_dir("tabcwd");
        let skills_dir = temp_dir("skillsdir");

        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, 'Test WS', 0, 0)",
            [&workspace_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES (?1, 'win', ?2, 1, 0)",
            rusqlite::params![window_id, workspace_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, created_at, last_active)
             VALUES (?1, ?2, 'Test tab', 'claude-code', 'Claude Code', 'claude', ?3, 0, 0)",
            rusqlite::params![tab_id, window_id, tab_cwd.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
            [skills_dir.to_string_lossy().to_string()],
        ).unwrap();

        (std::sync::Arc::new(std::sync::Mutex::new(conn)), workspace_id, tab_id, tab_cwd, skills_dir)
    }

    fn write_source_skill(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\n\
             name: git-commit-helper\n\
             description: Genera mensajes de commit siguiendo conventional commits.\n\
             version: 1.2.0\n\
             categories: [git, productivity]\n\
             compatible_agents: [claude-code, gemini-cli]\n\
             compatible_versions:\n  claude-code: \">=1.5.0\"\n\
             author: luis3132\n\
             license: MIT\n\
             homepage: https://example.com/skill\n\
             ---\n\
             Cuerpo de la skill de prueba.\n",
        ).unwrap();
    }

    #[test]
    fn full_lifecycle_install_attach_edit_detach_delete() {
        let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
        let app = tauri::test::mock_app();
        app.manage(db);
        let state = app.state::<DbConnection>();

        // 1) install_skill: copia real de carpeta + parseo de frontmatter enriquecido.
        let source = temp_dir("source-skill");
        write_source_skill(&source);
        let info = install_skill(source.join("SKILL.md").to_string_lossy().to_string(), None, state.clone())
            .expect("install_skill debería funcionar");
        assert_eq!(info.name, "git-commit-helper");
        assert_eq!(info.version, "1.2.0");
        assert_eq!(info.categories, vec!["git", "productivity"]);
        assert_eq!(info.compatible_agents, vec!["claude-code", "gemini-cli"]);
        assert_eq!(info.compatible_versions.get("claude-code"), Some(&">=1.5.0".to_string()));
        assert_eq!(info.author.as_deref(), Some("luis3132"));
        assert_eq!(info.license.as_deref(), Some("MIT"));
        assert!(Path::new(&info.source_path).join("SKILL.md").exists(), "la copia global debe existir en disco");

        // 2) list_skills: aparece, sin usage todavía.
        let listed = list_skills(state.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].used_by.len(), 0);

        // 3) attach_skill (scope='tab'): debe crear un symlink REAL en el cwd de la tab.
        attach_skill(info.id.clone(), workspace_id.clone(), "tab".to_string(), Some(tab_id.clone()), state.clone())
            .expect("attach_skill debería funcionar");

        let expected_link = link_path_for(&tab_cwd.to_string_lossy(), "claude-code", &slug_from_source_path(&info.source_path)).unwrap();
        let link_meta = std::fs::symlink_metadata(&expected_link).expect("el symlink debe existir en disco");
        assert!(link_meta.file_type().is_symlink(), "debe ser un symlink, no una copia");
        let target = std::fs::read_link(&expected_link).unwrap();
        assert_eq!(target, Path::new(&info.source_path), "el symlink debe apuntar a la copia global");

        // Idempotencia: attachear de nuevo no debe fallar ni duplicar el link.
        attach_skill(info.id.clone(), workspace_id.clone(), "tab".to_string(), Some(tab_id.clone()), state.clone())
            .expect("attach_skill debe ser idempotente");

        // 4) used_by ahora refleja el attachment.
        let listed = list_skills(state.clone()).unwrap();
        assert_eq!(listed[0].used_by.len(), 1);
        assert_eq!(listed[0].used_by[0].workspace_id, workspace_id);
        assert_eq!(listed[0].used_by[0].tab_id.as_deref(), Some(tab_id.as_str()));

        // 5) health check: todo sano.
        let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
        assert!(health.is_empty(), "no debería haber problemas de symlink recién attacheado");

        // 6) edit: update_skill_content reescribe SKILL.md y re-parsea metadata (version bump).
        let detail = get_skill_detail(info.id.clone(), state.clone()).unwrap();
        assert!(detail.content.contains("git-commit-helper"));
        let new_content = detail.content.replace("version: 1.2.0", "version: 1.3.0");
        update_skill_content(info.id.clone(), new_content, state.clone()).unwrap();
        let detail = get_skill_detail(info.id.clone(), state.clone()).unwrap();
        assert_eq!(detail.skill.version, "1.3.0", "la versión debe reflejar el nuevo frontmatter");

        // 7) simular un symlink roto borrándolo a mano por fuera de la app.
        std::fs::remove_file(&expected_link).unwrap();
        let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
        assert_eq!(health.len(), 1);
        assert_eq!(health[0].issue, "missing");

        // Reparar: volver a attachear debe recrear el symlink.
        attach_skill(info.id.clone(), workspace_id.clone(), "tab".to_string(), Some(tab_id.clone()), state.clone()).unwrap();
        assert!(std::fs::symlink_metadata(&expected_link).is_ok());
        let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
        assert!(health.is_empty());

        // 8) detach_skill: el symlink debe desaparecer y el attachment también.
        detach_skill(info.id.clone(), workspace_id.clone(), "tab".to_string(), Some(tab_id.clone()), state.clone()).unwrap();
        assert!(std::fs::symlink_metadata(&expected_link).is_err(), "el symlink debe haberse removido");
        let listed = list_skills(state.clone()).unwrap();
        assert_eq!(listed[0].used_by.len(), 0);

        // 9) delete_skill: borra la fila y la copia global del disco.
        delete_skill(info.id.clone(), state.clone()).unwrap();
        let listed = list_skills(state.clone()).unwrap();
        assert!(listed.is_empty());
        assert!(!Path::new(&info.source_path).exists(), "la copia global debe haberse borrado");
    }

    #[test]
    fn preview_detects_missing_metadata_and_install_persists_overrides() {
        let (db, _workspace_id, _tab_id, _tab_cwd, _skills_dir) = setup();
        let app = tauri::test::mock_app();
        app.manage(db);
        let state = app.state::<DbConnection>();

        // SKILL.md sin ninguna metadata más allá del name — todo lo demás debe salir
        // como "missing" para que el frontend ofrezca completarlo (opcional).
        let source = temp_dir("bare-skill");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: bare-skill\n---\nCuerpo sin metadata.\n",
        ).unwrap();

        let preview = preview_skill_metadata(source.join("SKILL.md").to_string_lossy().to_string()).unwrap();
        assert!(preview.folder_name.starts_with("cc-skills-test-bare-skill"));
        for field in ["description", "version", "categories", "compatibleAgents", "author", "license", "homepage"] {
            assert!(preview.missing.iter().any(|m| m == field), "{field} debería estar marcado como faltante");
        }

        // Instalar SIN completar nada (opcional/skip): no debe fallar, y los campos
        // quedan vacíos tal cual — completar metadata nunca es obligatorio.
        let installed_bare = install_skill(source.join("SKILL.md").to_string_lossy().to_string(), None, state.clone())
            .expect("instalar sin completar metadata debe funcionar igual");
        assert_eq!(installed_bare.version, "0.1.0");
        assert!(installed_bare.categories.is_empty());

        // Instalar completando algunos campos sugeridos (el resto queda vacío/omitido).
        let source2 = temp_dir("bare-skill-2");
        std::fs::create_dir_all(&source2).unwrap();
        std::fs::write(
            source2.join("SKILL.md"),
            "---\nname: bare-skill-2\n---\nCuerpo sin metadata.\n",
        ).unwrap();
        let overrides = SkillFrontmatterInput {
            name: None,
            description: Some("Completada a mano por el usuario".to_string()),
            version: Some("2.0.0".to_string()),
            categories: vec!["testing".to_string()],
            compatible_agents: vec![],
            compatible_versions: HashMap::new(),
            author: None,
            license: None,
            homepage: None,
        };
        let installed = install_skill(source2.join("SKILL.md").to_string_lossy().to_string(), Some(overrides), state.clone())
            .expect("instalar con overrides parciales debe funcionar");
        assert_eq!(installed.description.as_deref(), Some("Completada a mano por el usuario"));
        assert_eq!(installed.version, "2.0.0");
        assert_eq!(installed.categories, vec!["testing"]);

        // El archivo instalado (la copia global) debe reflejar en disco lo completado.
        let written = std::fs::read_to_string(Path::new(&installed.source_path).join("SKILL.md")).unwrap();
        assert!(written.contains("version: 2.0.0"));
        assert!(written.contains("Completada a mano por el usuario"));
        assert!(written.contains("Cuerpo sin metadata."), "el body original debe preservarse");
    }
}
