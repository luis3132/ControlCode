//! Consultas sobre las skills instaladas: listarlas, ver su detalle y editarlas.

use rusqlite::OptionalExtension;
use std::path::Path;

use crate::database::DbConnection;

use super::frontmatter::parse_frontmatter;
use crate::util::now_ts;

use super::types::{SkillDetail, SkillInfo, SkillUsageEntry, SkillWithUsage};

pub(super) fn row_to_skill_info(row: &rusqlite::Row) -> rusqlite::Result<SkillInfo> {
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
        registry_id: row.get(13)?,
        registry_name: row.get(14)?,
    })
}

pub(super) const SKILL_COLUMNS: &str = "id, name, description, categories, compatible_agents, compatible_versions, version, author, license, homepage, source_path, installed_at, updated_at, registry_id, registry_name";

/// Mismas columnas y en el mismo orden que `SKILL_COLUMNS` (las lee el mismo
/// `row_to_skill_info`), pero calificadas con el alias `s` — necesario en las queries que
/// joinean `skills` con `tabs`/`windows`, donde `id`/`name` serían ambiguos.
pub(super) const SKILL_COLUMNS_QUALIFIED: &str = "s.id, s.name, s.description, s.categories, s.compatible_agents, s.compatible_versions, s.version, s.author, s.license, s.homepage, s.source_path, s.installed_at, s.updated_at, s.registry_id, s.registry_name";

pub(super) fn fetch_usage_for_skill(conn: &rusqlite::Connection, skill_id: &str) -> Result<Vec<SkillUsageEntry>, String> {
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
pub(super) fn collect_linked_tabs(conn: &rusqlite::Connection, skill_id: &str) -> Result<Vec<(String, String)>, String> {
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

/// Skills instaladas desde un repositorio concreto. La usa el diálogo de borrar un repo
/// para poder listarle al usuario, por nombre, qué se va a llevar puesto la operación —
/// borrar el repo borra sus skills, y eso no puede ser una sorpresa.

#[tauri::command]
pub fn registry_skills(
    registry_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<SkillInfo>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SKILL_COLUMNS} FROM skills WHERE registry_id = ?1 ORDER BY name COLLATE NOCASE"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&registry_id], row_to_skill_info)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
