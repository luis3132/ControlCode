//! Del árbol mezclado a esta máquina: lo que llegó del repo se aplica, lo que se borró en
//! otra máquina se borra acá.
//!
//! Se compara contra lo que esta máquina exportó (`Local`) y solo se toca lo que difiere:
//! una sincronización sin cambios no reescribe nada.
//!
//! Lo que no se puede aplicar (una skill de skills.sh sin Node, un nombre de carpeta ya
//! tomado por otra skill acá) no frena el resto: queda como pendiente y se informa (ver
//! `Pending`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use super::export::{
    Local, Pending, AGENTS_DOC, MARKET_DOC, PRELAUNCH_DOC, PREFS_DOC, SETTINGS_DOC, SKILLS_PREFIX, SYNCED_SETTINGS,
};
use super::tree::{doc, group_files, groups, Tree};
use crate::database::DbConnection;

#[derive(Debug, Default)]
pub(super) struct Applied {
    /// Qué cambió en esta máquina, en palabras.
    pub changes: Vec<String>,
    pub failures: Vec<String>,
    pub pending: Pending,
    /// Las preferencias del webview: las aplica el frontend.
    pub prefs: Map<String, Value>,
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(super) fn apply_db(conn: &Connection, merged: &Tree, local: &Tree, out: &mut Applied) -> Result<(), String> {
    // Preferencias guardadas en `settings`.
    let (m, l) = (doc(merged, SETTINGS_DOC), doc(local, SETTINGS_DOC));
    for key in SYNCED_SETTINGS {
        let wanted = m.get(*key).and_then(Value::as_str);
        let Some(v) = wanted.filter(|w| Some(*w) != l.get(*key).and_then(Value::as_str)) else { continue };
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )
        .map_err(|e| e.to_string())?;
        out.changes.push(format!("setting {key}"));
    }

    // Comandos previos, por nombre.
    let (m, l) = (doc(merged, PRELAUNCH_DOC), doc(local, PRELAUNCH_DOC));
    for (name, command) in &m {
        let Some(command) = command.as_str() else { continue };
        if l.get(name).and_then(Value::as_str) != Some(command) {
            conn.execute(
                "INSERT INTO prelaunch_presets (id, name, command, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(name) DO UPDATE SET command = excluded.command",
                params![uuid::Uuid::new_v4().to_string(), name, command, crate::util::now_ts()],
            )
            .map_err(|e| e.to_string())?;
            out.changes.push(format!("prelaunch {name}"));
        }
    }
    for name in l.keys().filter(|n| !m.contains_key(*n)) {
        conn.execute("DELETE FROM prelaunch_presets WHERE name = ?1", [name]).map_err(|e| e.to_string())?;
        out.changes.push(format!("prelaunch {name} (removed)"));
    }

    // TUIs propias, por id. Las variables de entorno no viajan: se conservan las de acá.
    let (m, l) = (doc(merged, AGENTS_DOC), doc(local, AGENTS_DOC));
    for (id, agent) in &m {
        if l.get(id) == Some(agent) {
            continue;
        }
        let (Some(label), Some(command)) = (str_of(agent, "label"), str_of(agent, "command")) else { continue };
        conn.execute(
            "INSERT INTO custom_agents (id, label, command, resume_args, skills_dir, sessions_dir, session_id_from, env_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', ?8)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label, command = excluded.command,
               resume_args = excluded.resume_args, skills_dir = excluded.skills_dir,
               sessions_dir = excluded.sessions_dir, session_id_from = excluded.session_id_from",
            params![
                id,
                label,
                command,
                str_of(agent, "resumeArgs"),
                str_of(agent, "skillsDir"),
                str_of(agent, "sessionsDir"),
                str_of(agent, "sessionIdFrom").unwrap_or_else(|| "filename".into()),
                crate::util::now_ts()
            ],
        )
        .map_err(|e| e.to_string())?;
        out.changes.push(format!("TUI {label}"));
    }
    for id in l.keys().filter(|i| !m.contains_key(*i)) {
        conn.execute("DELETE FROM custom_agents WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        out.changes.push(format!("TUI {id} (removed)"));
    }
    Ok(())
}

/// Si la carpeta de skill `folder` ya la usa otra skill de esta máquina (de un repositorio,
/// por ejemplo): el nombre es también el del symlink en los proyectos, no puede repetirse.
fn folder_taken(conn: &Connection, skills_dir: &Path, folder: &str) -> bool {
    if skills_dir.join("local").join(folder).exists() {
        return true;
    }
    let mut stmt = match conn.prepare("SELECT source_path FROM skills") {
        Ok(s) => s,
        Err(_) => return true,
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.flatten().any(|p| Path::new(&p).file_name().is_some_and(|f| f == folder)))
        .unwrap_or(true)
}

/// Deja la carpeta con exactamente esos archivos. El instalador normaliza el `SKILL.md`
/// (reescribe el frontmatter): si lo instalado no quedara byte a byte igual al repo, la
/// próxima sincronización lo vería "modificado acá", y como modificar le gana a borrar, un
/// borrado hecho en otra máquina no llegaría nunca.
fn write_exact(dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    for (rel, bytes) in files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Escribe los archivos de una skill en una carpeta de paso, para instalarla desde ahí con
/// el mismo código que cualquier instalación.
fn stage(staging: &Path, folder: &str, files: &BTreeMap<String, Vec<u8>>) -> Result<PathBuf, String> {
    let dir = staging.join(folder);
    let _ = std::fs::remove_dir_all(&dir);
    for (rel, bytes) in files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(dir.join("SKILL.md"))
}

pub(super) fn apply_skills(db: &DbConnection, data_dir: &Path, merged: &Tree, local: &Local, out: &mut Applied) {
    let staging = data_dir.join("sync").join("staging");
    let merged_folders = groups(merged, SKILLS_PREFIX);
    for folder in &merged_folders {
        let wanted = group_files(merged, SKILLS_PREFIX, folder);
        if wanted == group_files(&local.tree, SKILLS_PREFIX, folder) {
            continue;
        }
        if !wanted.contains_key("SKILL.md") {
            out.failures.push(format!("skill {folder}: no SKILL.md"));
            out.pending.skills.insert(folder.clone());
            continue;
        }
        let source = match stage(&staging, folder, &wanted) {
            Ok(s) => s,
            Err(e) => {
                out.failures.push(format!("skill {folder}: {e}"));
                out.pending.skills.insert(folder.clone());
                continue;
            }
        };
        let source = source.to_string_lossy().to_string();
        let result = match local.skills.get(folder) {
            // Se actualiza en su lugar: conserva el id, y con él los proyectos que la usan.
            Some(existing) => crate::skills::update_installed(&existing.id, &existing.path, &source, None, db)
                .map(|_| PathBuf::from(&existing.path)),
            None => install_new(db, folder, &source),
        }
        .and_then(|dir| write_exact(&dir, &wanted));
        match result {
            Ok(()) => out.changes.push(format!("skill {folder}")),
            Err(e) => {
                out.failures.push(format!("skill {folder}: {e}"));
                out.pending.skills.insert(folder.clone());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&staging);

    for (folder, skill) in &local.skills {
        if !merged_folders.contains(folder) {
            match crate::skills::delete_skill_internal(&skill.id, db) {
                Ok(()) => out.changes.push(format!("skill {folder} (removed)")),
                Err(e) => out.failures.push(format!("skill {folder}: {e}")),
            }
        }
    }
}

/// Una skill que llega de otra máquina: se instala con el mismo nombre de carpeta que tiene
/// en el repo. Si la instalación le pusiera otro (`foo-2`), la próxima exportación la
/// subiría con ese nombre y las dos máquinas se la pasarían renombrada para siempre.
fn install_new(db: &DbConnection, folder: &str, source: &str) -> Result<PathBuf, String> {
    let skills_dir = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        crate::skills::skills_dir_from_conn(&conn)?
    };
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if folder_taken(&conn, &skills_dir, folder) {
            return Err(format!("another skill here already uses the name «{folder}»"));
        }
    }
    let info = crate::skills::install_skill_internal(source, None, None, db)?;
    let installed = PathBuf::from(&info.source_path);
    if installed.file_name().is_none_or(|f| f == folder) {
        return Ok(installed);
    }
    let target = installed.with_file_name(folder);
    std::fs::rename(&installed, &target).map_err(|e| e.to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE skills SET source_path = ?1 WHERE id = ?2",
        params![target.to_string_lossy().to_string(), info.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(target)
}

async fn apply_marketplace(app: &AppHandle, db: &DbConnection, merged: &Tree, local: &Local, out: &mut Applied) {
    let (m, l) = (doc(merged, MARKET_DOC), doc(&local.tree, MARKET_DOC));
    let empty = Map::new();
    let m_regs = m.get("registries").and_then(Value::as_object).unwrap_or(&empty);
    let l_regs = l.get("registries").and_then(Value::as_object).unwrap_or(&empty);
    let mut ids: BTreeMap<String, String> = local.registries.clone();

    // Repositorios nuevos (los agrega y los refresca: por eso esto es async).
    for (key, reg) in m_regs {
        let (Some(name), Some(kind), Some(location)) = (str_of(reg, "name"), str_of(reg, "sourceType"), str_of(reg, "location"))
        else {
            continue;
        };
        let enabled = reg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        match ids.get(key).cloned() {
            None => match crate::marketplace::add_registry(None, name.clone(), kind, location, app.state(), app.clone()).await {
                Ok(summary) => {
                    if !enabled {
                        let _ = crate::marketplace::set_registry_enabled(summary.id.clone(), false, app.state());
                    }
                    ids.insert(key.clone(), summary.id);
                    out.changes.push(format!("repository {name}"));
                }
                Err(e) => out.failures.push(format!("repository {name}: {e}")),
            },
            Some(id) => {
                let before = l_regs.get(key);
                if before.and_then(|b| str_of(b, "name")).as_deref() != Some(name.as_str()) {
                    let _ = crate::marketplace::rename_registry(id.clone(), name.clone(), app.state());
                }
                if before.and_then(|b| b.get("enabled")).and_then(Value::as_bool) != Some(enabled) {
                    let _ = crate::marketplace::set_registry_enabled(id, enabled, app.state());
                }
            }
        }
    }

    // Skills de repositorios.
    let m_skills = m.get("skills").and_then(Value::as_object).unwrap_or(&empty);
    for (key, skill) in m_skills {
        if local.market.contains_key(key) {
            continue;
        }
        let (Some(reg_key), Some(entry)) = (str_of(skill, "registry"), str_of(skill, "entryId")) else { continue };
        let name = str_of(skill, "name").unwrap_or_else(|| entry.clone());
        let Some(reg_id) = ids.get(&reg_key).cloned() else {
            out.failures.push(format!("skill {name}: its repository is not here"));
            out.pending.marketplace.insert(key.clone());
            continue;
        };
        // skills.sh no se puede listar: su cache solo tiene lo que se buscó. Se busca por el
        // nombre para que la entrada esté cuando se instala.
        if reg_key.starts_with("skillssh:") {
            let _ = crate::marketplace::search_remote_conn(db, &name).await;
        }
        match crate::marketplace::install_marketplace_skill(reg_id, entry, app.state()).await {
            Ok(_) => out.changes.push(format!("skill {name}")),
            Err(e) => {
                out.failures.push(format!("skill {name}: {e}"));
                out.pending.marketplace.insert(key.clone());
            }
        }
    }
    for (key, skill) in &local.market {
        if !m_skills.contains_key(key) {
            match crate::skills::delete_skill_internal(&skill.id, db) {
                Ok(()) => out.changes.push(format!("skill {key} (removed)")),
                Err(e) => out.failures.push(format!("skill {key}: {e}")),
            }
        }
    }

    // Repositorios borrados en otra máquina: al final, porque borrar uno se lleva sus skills.
    for (key, id) in &local.registries {
        if !m_regs.contains_key(key) {
            match crate::marketplace::remove_registry(id.clone(), app.state()) {
                Ok(_) => out.changes.push(format!("repository {key} (removed)")),
                Err(e) => out.failures.push(format!("repository {key}: {e}")),
            }
        }
    }
}

pub(super) async fn apply(app: &AppHandle, data_dir: &Path, merged: &Tree, local: &Local) -> Applied {
    let mut out = Applied { prefs: doc(merged, PREFS_DOC), ..Default::default() };
    let Some(db) = app.try_state::<DbConnection>().map(|s| s.inner().clone()) else {
        out.failures.push("database not ready".into());
        return out;
    };
    {
        let result = match db.lock() {
            Ok(conn) => apply_db(&conn, merged, &local.tree, &mut out),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = result {
            out.failures.push(format!("config: {e}"));
        }
    }
    apply_skills(&db, data_dir, merged, local, &mut out);
    apply_marketplace(app, &db, merged, local, &mut out).await;
    out
}

/// Para la próxima vez: lo pendiente guardado en `settings`.
pub(super) fn load_pending(conn: &Connection) -> Pending {
    conn.query_row("SELECT value FROM settings WHERE key = 'sync.pending'", [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}
