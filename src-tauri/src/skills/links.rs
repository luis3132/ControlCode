//! Los symlinks: qué skill tiene que estar montada en qué carpeta de qué tab.
//!
//! La fuente de verdad son las filas de `project_skills`; lo que hay en disco se deriva
//! de ellas y se re-verifica en cada reconciliación.

use rusqlite::OptionalExtension;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::database::DbConnection;

use super::files::slug_from_source_path;
use super::settings::skills_dir_from_conn;
use super::store::{row_to_skill_info, SKILL_COLUMNS, SKILL_COLUMNS_QUALIFIED};
use crate::util::now_ts;

use super::types::{SkillInfo, SymlinkHealthEntry};

/// Remueve un symlink si existe, ignorando errores (ya borrado a mano, roto, etc.) —
/// usado por delete_skill/detach_skill, donde una limpieza a medias no debe bloquear
/// el resto de la operación.
pub(super) fn remove_symlink_best_effort(path: &Path) {
    if path.symlink_metadata().is_ok() {
        let _ = symlink::remove_symlink_auto(path);
    }
}

/// Convención de path del symlink dentro del cwd de una tab, según el agente —
/// verificado contra la documentación real de cada CLI (no asumido):
/// - Claude Code: `.claude/skills/<slug>/SKILL.md` (docs.claude.com/en/docs/claude-code/skills).
/// - Gemini CLI, OpenCode, Codex y Kimi Code adoptan el mismo estándar abierto de
///   "Agent Skills" bajo `.agents/skills/<slug>/SKILL.md` a nivel de proyecto — un solo
///   symlink ahí lo ven los cuatro sin duplicar nada. Gemini CLI también acepta
///   `.gemini/skills/` pero `.agents/skills/` tiene prioridad si ambas existen, así que
///   alcanza con esa. Fuentes: github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md,
///   opencode.ai/docs/skills, learn.chatgpt.com/docs/build-skills,
///   github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/skills.md.
///
/// Devuelve la carpeta que contiene esos symlinks — el "directorio gestionado" que la
/// reconciliación deja idéntico al set de skills que piden las tabs vivas de ese cwd.
///
/// Solo resuelve los agentes soportados de fábrica; para una TUI custom hay que usar
/// `links_dir_for_conn`, que consulta la carpeta que el usuario le declaró.
pub fn links_dir_for(cwd: &str, agent_id: &str) -> Option<PathBuf> {
    let subdir = match agent_id {
        "claude-code" => ".claude/skills",
        "gemini-cli" | "opencode" | "codex" | "kimi-code" => ".agents/skills",
        _ => return None,
    };
    Some(Path::new(cwd).join(subdir))
}

/// Igual que `links_dir_for` pero cayendo a la configuración de la TUI custom cuando el
/// id no es uno de los conocidos. Es la variante que usa todo el camino de reconciliación
/// (que siempre tiene la conexión a mano); `links_dir_for` queda para los casos donde no
/// hay DB disponible.
pub(super) fn links_dir_for_conn(conn: &rusqlite::Connection, cwd: &str, agent_id: &str) -> Option<PathBuf> {
    if let Some(dir) = links_dir_for(cwd, agent_id) {
        return Some(dir);
    }
    let custom = crate::agents::find(conn, agent_id)?;
    let raw = custom.skills_dir?;
    let raw = raw.trim().trim_start_matches("./");
    if raw.is_empty() {
        return None;
    }
    Some(Path::new(cwd).join(raw))
}

pub(super) fn link_path_for_conn(
    conn: &rusqlite::Connection,
    cwd: &str,
    agent_id: &str,
    slug: &str,
) -> Option<PathBuf> {
    Some(links_dir_for_conn(conn, cwd, agent_id)?.join(slug))
}

/// Una skill sin `compatible_agents` declarados aplica a cualquier agente; si los declara,
/// solo a los listados.
pub(super) fn agent_is_compatible(skill: &SkillInfo, agent_id: &str) -> bool {
    skill.compatible_agents.is_empty() || skill.compatible_agents.iter().any(|a| a == agent_id)
}

/// Skills que las tabs VIVAS (las de ventanas con `is_open = 1`) que corren en este
/// cwd con este agente tienen attacheadas — por su workspace (scope='workspace') o
/// directamente por la tab (scope='tab').
///
/// El filtro por ventana abierta es lo que liga las skills a lo que está realmente
/// abierto: las tabs de un workspace cerrado siguen existiendo como filas (para poder
/// restaurarlo) pero ya no reclaman ningún symlink, así que abrir otro workspace en la
/// misma carpeta no arrastra las skills del anterior.
pub(super) fn desired_skills_for_link_dir(
    conn: &rusqlite::Connection,
    cwd: &str,
    agent_id: &str,
) -> Result<Vec<SkillInfo>, String> {
    let query = format!(
        "SELECT DISTINCT {SKILL_COLUMNS_QUALIFIED} FROM skills s
         JOIN tabs t ON t.cwd = ?1 AND t.agent_id = ?2
         JOIN windows w ON w.id = t.window_id AND w.is_open = 1
         JOIN project_skills ps ON ps.skill_id = s.id AND ps.workspace_id = w.workspace_id
         WHERE ps.enabled = 1
           AND (ps.scope = 'workspace' OR (ps.scope = 'tab' AND ps.tab_id = t.id))"
    );
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([cwd, agent_id], row_to_skill_info)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Deja el directorio de skills de un (cwd, agente) exactamente con los symlinks que
/// piden sus tabs vivas: borra los que sobraron (de un workspace/tab anterior que ya no
/// está abierto, o de una skill que se detacheó) y crea/repara los que faltan.
///
/// Solo toca symlinks que apuntan dentro del directorio global de skills — o sea, los que
/// creó Control Code. Un `.claude/skills/<x>` propio del usuario (carpeta real o symlink
/// a otro lado) nunca se borra.
///
/// Best-effort por diseño: corre en el arranque de cada tab y en cada cierre de
/// tab/ventana, donde un conflicto puntual (ej. una carpeta real ocupando el path de un
/// symlink) no debe abortar la operación — `check_symlinks_health` lo reporta después.
pub(crate) fn reconcile_link_dir(
    conn: &rusqlite::Connection,
    cwd: &str,
    agent_id: &str,
) -> Result<(), String> {
    let Some(dir) = links_dir_for_conn(conn, cwd, agent_id) else { return Ok(()) };
    let skills_dir = skills_dir_from_conn(conn)?;

    let desired: Vec<SkillInfo> = desired_skills_for_link_dir(conn, cwd, agent_id)?
        .into_iter()
        .filter(|s| agent_is_compatible(s, agent_id))
        .collect();
    let keep: std::collections::HashSet<String> =
        desired.iter().map(|s| slug_from_source_path(&s.source_path)).collect();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = path.symlink_metadata() else { continue };
            if !meta.file_type().is_symlink() {
                continue; // carpeta/archivo real del usuario
            }
            // `read_link` funciona igual con un symlink roto, así que uno colgado que
            // apunta a la copia global (skill borrada a mano) también se limpia acá.
            let Ok(target) = std::fs::read_link(&path) else { continue };
            if !target.starts_with(&skills_dir) {
                continue; // symlink que no gestiona Control Code
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !keep.contains(&name) {
                remove_symlink_best_effort(&path);
            }
        }
    }

    for skill in &desired {
        let _ = ensure_symlink(conn, skill, cwd, agent_id);
    }

    // Si no quedó ninguna skill, tampoco queda el directorio vacío tirado en el repo del
    // usuario (`remove_dir` falla solo si no está vacío, que es justo lo que queremos).
    let _ = std::fs::remove_dir(&dir);

    Ok(())
}

/// `reconcile_link_dir` sobre varios (cwd, agente) deduplicados. Los llamadores suelen
/// juntar los pares afectados antes de mutar la DB (cerrar una tab, cerrar una ventana) y
/// reconciliar después, cuando el estado nuevo ya está persistido.
pub(crate) fn reconcile_link_dirs(conn: &rusqlite::Connection, pairs: &[(String, String)]) {
    let mut seen = std::collections::HashSet::new();
    for (cwd, agent_id) in pairs {
        if seen.insert((cwd.clone(), agent_id.clone())) {
            let _ = reconcile_link_dir(conn, cwd, agent_id);
        }
    }
}

/// (cwd, agent_id) de todas las tabs de una ventana — para reconciliar sus directorios
/// después de cerrarla/borrarla.
pub(crate) fn link_dirs_of_window(
    conn: &rusqlite::Connection,
    window_id: &str,
) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare("SELECT cwd, agent_id FROM tabs WHERE window_id = ?1") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([window_id], |r| Ok((r.get(0)?, r.get(1)?))) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// (cwd, agent_id) de todas las tabs de un workspace — misma idea que
/// `link_dirs_of_window` pero para operaciones que afectan al workspace entero.
pub(crate) fn link_dirs_of_workspace(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT t.cwd, t.agent_id FROM tabs t JOIN windows w ON w.id = t.window_id
         WHERE w.workspace_id = ?1",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([workspace_id], |r| Ok((r.get(0)?, r.get(1)?))) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// Reconcilia el directorio de skills de una tab puntual. El frontend lo llama justo
/// antes de lanzar el proceso del agente (ver `Terminal.tsx`): es el momento en que hay
/// que garantizar que en esa carpeta están las skills de ESTA tab/workspace y ninguna
/// otra, porque varios agentes escanean su carpeta de skills una sola vez, al arrancar.
#[tauri::command]
pub fn reconcile_tab_skills(tab_id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let row: Option<(String, String)> = conn
        .query_row("SELECT cwd, agent_id FROM tabs WHERE id = ?1", [&tab_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((cwd, agent_id)) = row else { return Ok(()) };
    reconcile_link_dir(&conn, &cwd, &agent_id)
}

pub(super) fn fetch_skill_row(conn: &rusqlite::Connection, skill_id: &str) -> Result<SkillInfo, String> {
    let query = format!("SELECT {SKILL_COLUMNS} FROM skills WHERE id = ?1");
    conn.query_row(&query, [skill_id], row_to_skill_info).map_err(|e| e.to_string())
}

/// Tabs (id, cwd, agent_id) de un workspace, o de una sola tab puntual si `tab_id` está
/// presente. Usado por attach/detach/health-check para resolver a qué tabs concretas
/// aplica un `project_skills` row, sin duplicar la lógica de scope en cada comando.
///
/// Solo devuelve tabs de ventanas abiertas: un workspace guardado y cerrado conserva sus
/// filas de `tabs` para poder restaurarse, pero sus skills no deben existir en disco
/// mientras no esté abierto (si no, se filtran al workspace que sí esté usando esa
/// carpeta). Los symlinks de esas tabs se crean al restaurarlas, vía
/// `reconcile_tab_skills`.
pub(super) fn tabs_for_scope(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    tab_id: Option<&str>,
) -> Result<Vec<(String, String, String)>, String> {
    if let Some(tab_id) = tab_id {
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT t.id, t.cwd, t.agent_id FROM tabs t
                 JOIN windows w ON w.id = t.window_id AND w.is_open = 1
                 WHERE t.id = ?1",
                [tab_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.into_iter().collect())
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.cwd, t.agent_id FROM tabs t
                 JOIN windows w ON w.id = t.window_id AND w.is_open = 1
                 WHERE w.workspace_id = ?1",
            )
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
pub(super) fn ensure_symlink(
    conn: &rusqlite::Connection,
    skill: &SkillInfo,
    cwd: &str,
    agent_id: &str,
) -> Result<(), String> {
    if !agent_is_compatible(skill, agent_id) {
        return Ok(()); // skill no aplica a este agente, no es un error
    }
    let slug = slug_from_source_path(&skill.source_path);
    let Some(link_path) = link_path_for_conn(conn, cwd, agent_id, &slug) else {
        return Ok(()); // agente sin carpeta de skills conocida ni declarada, se saltea
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

    // Si una tab falla a mitad del loop (ej. destino ya existe y no es symlink), las
    // symlinks ya creadas para tabs anteriores no deben quedar huérfanas en disco sin
    // fila en `project_skills` — ni `check_symlinks_health` ni `delete_skill` las verían.
    // Se deshacen las que sí se crearon en esta llamada antes de propagar el error.
    let mut created: Vec<(&str, &str)> = Vec::new();
    for (_, cwd, agent_id) in &tabs {
        if let Err(e) = ensure_symlink(&conn, &skill, cwd, agent_id) {
            let slug = slug_from_source_path(&skill.source_path);
            for (cwd, agent_id) in &created {
                if let Some(link_path) = link_path_for_conn(&conn, cwd, agent_id, &slug) {
                    remove_symlink_best_effort(&link_path);
                }
            }
            return Err(e);
        }
        created.push((cwd.as_str(), agent_id.as_str()));
    }

    let now = now_ts();
    conn.execute(
        "INSERT INTO project_skills (id, skill_id, workspace_id, scope, tab_id, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
         ON CONFLICT(skill_id, workspace_id, scope, tab_id) DO UPDATE SET enabled = 1",
        rusqlite::params![Uuid::new_v4().to_string(), skill_id, workspace_id, scope, tab_id, now],
    )
    .map_err(|e| e.to_string())?;

    // Ya con la fila persistida, dejar los directorios afectados exactamente con el set
    // de skills que corresponde — barre de paso cualquier symlink colgado de un workspace
    // anterior que hubiera usado la misma carpeta.
    let pairs: Vec<(String, String)> =
        tabs.iter().map(|(_, cwd, agent)| (cwd.clone(), agent.clone())).collect();
    reconcile_link_dirs(&conn, &pairs);

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
    let tabs = tabs_for_scope(&conn, &workspace_id, tab_id.as_deref())?;

    conn.execute(
        "DELETE FROM project_skills WHERE skill_id = ?1 AND workspace_id = ?2 AND scope = ?3
         AND ((tab_id IS NULL AND ?4 IS NULL) OR tab_id = ?4)",
        rusqlite::params![skill_id, workspace_id, scope, tab_id],
    )
    .map_err(|e| e.to_string())?;

    // El symlink se quita reconciliando, no borrándolo a mano: la misma skill puede seguir
    // attacheada por otra vía (detachearla de una tab cuando el workspace entero la tiene
    // activa no debe dejar a esa tab sin la skill).
    let pairs: Vec<(String, String)> =
        tabs.iter().map(|(_, cwd, agent)| (cwd.clone(), agent.clone())).collect();
    reconcile_link_dirs(&conn, &pairs);

    Ok(())
}

/// Deja los symlinks de TODAS las tabs abiertas de un workspace alineados con sus
/// attachments — usado tras crear una tab nueva (para que herede las skills de
/// scope='workspace' ya activas) y tras abrir un workspace.
///
/// Reconcilia en vez de solo crear: además de agregar lo que falta, quita de esas
/// carpetas las skills que quedaron de otro workspace o de una tab ya cerrada.
#[tauri::command]
pub fn sync_workspace_skills(workspace_id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let tabs = tabs_for_scope(&conn, &workspace_id, None)?;
    let pairs: Vec<(String, String)> =
        tabs.into_iter().map(|(_, cwd, agent)| (cwd, agent)).collect();
    reconcile_link_dirs(&conn, &pairs);
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
            if !agent_is_compatible(&skill, &agent_id) {
                continue;
            }
            let Some(link_path) = link_path_for_conn(&conn, &cwd, &agent_id, &slug) else { continue };

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
