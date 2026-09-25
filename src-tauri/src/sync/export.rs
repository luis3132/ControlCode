//! De esta máquina al árbol de sincronización: qué se sube y con qué forma.
//!
//! ## Qué va
//!
//! - `skills/<carpeta>/…`: las skills del usuario (creadas, copias editadas de otras,
//!   instaladas a mano) — las que no vienen de ningún repositorio. Enteras, con sus scripts.
//! - `marketplace.json`: los repositorios de skills y qué skills de ellos hay instaladas,
//!   para volver a bajarlas. Un repositorio se identifica por tipo y ubicación
//!   (`github:owner/repo`), no por su id: el id es distinto en cada máquina.
//! - `config/*.json`: comandos previos, TUIs propias, preferencias de la app.
//!
//! ## Qué NO va, a propósito
//!
//! Tokens y cuentas (el llavero, las carpetas de login de las TUIs), las variables de
//! entorno de las TUIs propias (suelen llevar claves), cookies del navegador, ventanas,
//! tabs, historial, rutas de esta máquina (la carpeta de skills, repositorios `local`) y
//! las skills que vienen con la app (cada instalación las trae).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::tree::{group_files, json_bytes, Tree};

pub(super) const SETTINGS_DOC: &str = "config/settings.json";
pub(super) const PRELAUNCH_DOC: &str = "config/prelaunch.json";
pub(super) const AGENTS_DOC: &str = "config/custom-agents.json";
pub(super) const PREFS_DOC: &str = "config/preferences.json";
pub(super) const MARKET_DOC: &str = "marketplace.json";
pub(super) const SKILLS_PREFIX: &str = "skills/";

/// Las claves de `settings` que son preferencias del usuario y no de esta máquina.
pub(super) const SYNCED_SETTINGS: &[&str] = &["graphify.steps", "runs.routing.tiers", "orchestrator_watch_limit"];

/// Las preferencias que viven en el webview (localStorage). Las manda el frontend.
pub const SYNCED_PREFS: &[&str] = &["language", "theme", "cc-terminal-zoom", "cc-terminal-input-marks", "cc-markdown-preview"];

/// El id del "repositorio" de las skills que trae la app: no se sincronizan.
const BUNDLED_REGISTRY: &str = "controlcode-builtin";

/// Un archivo de una skill más grande que esto no se sube: un repo de configuración no es
/// lugar para binarios pesados.
const MAX_FILE: u64 = 2 * 1024 * 1024;

/// Lo que quedó en el árbol mezclado pero esta máquina no pudo aplicar (una skill de
/// skills.sh sin Node instalado, un nombre de carpeta ya tomado). Se sigue exportando como
/// estaba: si no, la próxima sincronización lo vería "borrado" y lo borraría del repo.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct Pending {
    #[serde(default)]
    pub skills: BTreeSet<String>,
    #[serde(default)]
    pub marketplace: BTreeSet<String>,
}

/// Una skill del usuario de esta máquina.
pub(super) struct LocalSkill {
    pub id: String,
    pub path: String,
}

/// Una skill instalada desde un repositorio.
pub(super) struct MarketSkill {
    pub id: String,
}

pub(super) struct Local {
    pub tree: Tree,
    /// Carpeta → skill del usuario.
    pub skills: BTreeMap<String, LocalSkill>,
    /// `tipo:ubicación` → id del repositorio en esta máquina.
    pub registries: BTreeMap<String, String>,
    /// `tipo:ubicación#entrada` → skill instalada.
    pub market: BTreeMap<String, MarketSkill>,
}

pub(super) fn registry_key(source_type: &str, location: &str) -> String {
    format!("{source_type}:{location}")
}

pub(super) fn market_key(registry: &str, entry: &str) -> String {
    format!("{registry}#{entry}")
}

fn readme() -> Vec<u8> {
    b"# Control Code sync\n\n\
This private repository is written by Control Code: your skills, which skills to install from \
which repositories, and your app preferences. Every machine where you connect it stays in sync.\n\n\
- `skills/` - the skills you created or edited, one folder each.\n\
- `marketplace.json` - skill repositories and the skills installed from them.\n\
- `config/` - pre-launch commands, custom TUIs and preferences.\n\n\
No tokens, logins, cookies or environment variables are ever written here. Editing files by \
hand works: the next sync picks the changes up.\n"
        .to_vec()
}

/// Los archivos de una carpeta, con rutas relativas y `/` como separador.
fn read_dir_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if meta.file_type().is_symlink() || name == ".git" || name == "node_modules" {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if let (true, Ok(rel), Ok(bytes)) = (meta.len() <= MAX_FILE, path.strip_prefix(root), std::fs::read(&path)) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), bytes);
            }
        }
    }
    out
}

pub(super) fn export(conn: &Connection, prefs: &Map<String, Value>, base: &Tree, pending: &Pending) -> Result<Local, String> {
    let mut tree = Tree::new();
    tree.insert("README.md".into(), readme());
    tree.insert(".controlcode-sync.json".into(), json_bytes(&json!({ "format": 1 })));

    // ── preferencias ──
    let mut settings = Map::new();
    for key in SYNCED_SETTINGS {
        if let Ok(Some(v)) = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, String>(0))
            .optional()
        {
            settings.insert((*key).to_string(), Value::String(v));
        }
    }
    tree.insert(SETTINGS_DOC.into(), json_bytes(&Value::Object(settings)));

    let prefs: Map<String, Value> = prefs
        .iter()
        .filter(|(k, v)| SYNCED_PREFS.contains(&k.as_str()) && v.is_string())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    tree.insert(PREFS_DOC.into(), json_bytes(&Value::Object(prefs)));

    // ── comandos previos ──
    let mut prelaunch = Map::new();
    let mut stmt = conn.prepare("SELECT name, command FROM prelaunch_presets").map_err(|e| e.to_string())?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())? {
        let (name, command) = row.map_err(|e| e.to_string())?;
        prelaunch.insert(name, Value::String(command));
    }
    tree.insert(PRELAUNCH_DOC.into(), json_bytes(&Value::Object(prelaunch)));

    // ── TUIs propias, sin sus variables de entorno ──
    let mut agents = Map::new();
    let mut stmt = conn
        .prepare("SELECT id, label, command, resume_args, skills_dir, sessions_dir, session_id_from FROM custom_agents")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({
                    "label": r.get::<_, String>(1)?,
                    "command": r.get::<_, String>(2)?,
                    "resumeArgs": r.get::<_, Option<String>>(3)?,
                    "skillsDir": r.get::<_, Option<String>>(4)?,
                    "sessionsDir": r.get::<_, Option<String>>(5)?,
                    "sessionIdFrom": r.get::<_, String>(6)?,
                }),
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, agent) = row.map_err(|e| e.to_string())?;
        agents.insert(id, agent);
    }
    tree.insert(AGENTS_DOC.into(), json_bytes(&Value::Object(agents)));

    // ── skills ──
    let mut skills = BTreeMap::new();
    let mut registries_by_id: BTreeMap<String, String> = BTreeMap::new();
    let mut registries = BTreeMap::new();
    let mut registry_docs = Map::new();
    let mut stmt = conn
        .prepare("SELECT id, name, source_type, location, enabled FROM registries")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, name, source_type, location, enabled) = row.map_err(|e| e.to_string())?;
        // Un repositorio `local` es una carpeta de esta máquina: en otra no existe.
        if source_type == "local" {
            continue;
        }
        let key = registry_key(&source_type, &location);
        registry_docs.insert(
            key.clone(),
            json!({ "name": name, "sourceType": source_type, "location": location, "enabled": enabled != 0 }),
        );
        registries_by_id.insert(id.clone(), key.clone());
        registries.insert(key, id);
    }

    let mut market = BTreeMap::new();
    let mut market_docs = Map::new();
    let mut stmt = conn
        .prepare("SELECT id, name, source_path, registry_id, origin_skill_id FROM skills")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, name, path, registry_id, origin) = row.map_err(|e| e.to_string())?;
        match registry_id.as_deref() {
            None => {
                let Some(folder) = Path::new(&path).file_name().map(|f| f.to_string_lossy().to_string()) else { continue };
                for (rel, bytes) in read_dir_files(Path::new(&path)) {
                    tree.insert(format!("{SKILLS_PREFIX}{folder}/{rel}"), bytes);
                }
                skills.insert(folder, LocalSkill { id, path });
            }
            Some(BUNDLED_REGISTRY) => {}
            Some(reg) => {
                // Sin entrada (instalaciones viejas) no hay cómo reinstalarla en otra máquina.
                let (Some(reg_key), Some(entry)) = (registries_by_id.get(reg), origin) else { continue };
                let key = market_key(reg_key, &entry);
                market_docs.insert(key.clone(), json!({ "name": name, "registry": reg_key, "entryId": entry }));
                market.insert(key, MarketSkill { id });
            }
        }
    }

    // Lo que esta máquina no pudo aplicar sigue como estaba en la base.
    let base_market = super::tree::doc(base, MARKET_DOC);
    let base_market_skills = base_market.get("skills").and_then(Value::as_object).cloned().unwrap_or_default();
    for key in &pending.marketplace {
        if let Some(v) = base_market_skills.get(key) {
            market_docs.entry(key.clone()).or_insert_with(|| v.clone());
        }
    }
    for folder in &pending.skills {
        if !skills.contains_key(folder) {
            for (rel, bytes) in group_files(base, SKILLS_PREFIX, folder) {
                tree.insert(format!("{SKILLS_PREFIX}{folder}/{rel}"), bytes);
            }
        }
    }

    tree.insert(
        MARKET_DOC.into(),
        json_bytes(&json!({ "registries": Value::Object(registry_docs), "skills": Value::Object(market_docs) })),
    );

    Ok(Local { tree, skills, registries, market })
}
