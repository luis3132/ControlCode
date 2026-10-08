//! Los modelos que ofrece el selector del chat, con su versión ("Opus 5.5", no "Opus").
//!
//! Dos fuentes, ninguna escrita acá:
//!
//! 1. **El catálogo de la TUI instalada.** El binario de Claude Code trae la lista de su
//!    selector de `/model` (`{id:"claude-opus-5-5",name:"Opus 5.5",…,section:"main"}`).
//!    Cambia con cada versión de la CLI, así que se lee de la que la persona tiene.
//! 2. **Lo que se usó de verdad.** Los alias los resuelve el servidor, y pueden apuntar a
//!    un modelo más nuevo que el del catálogo (el alias `haiku` corrió como
//!    `claude-haiku-5-5` con un catálogo que todavía decía Haiku 4.5). Cada respuesta deja
//!    su modelo en el `.jsonl` de la sesión: se miran las más recientes.

use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Lo que recibe `--model`.
    pub id: String,
    /// "Opus 5.5". `None` = no vino en el catálogo; el frontend lo arma del id.
    pub name: Option<String>,
}

lazy_static::lazy_static! {
    static ref CATALOG: regex::bytes::Regex = regex::bytes::Regex::new(
        r#"\{id:"(claude-[a-z0-9-]+)",name:"([A-Za-z]+ [0-9.]+)",short_name:"[A-Za-z]+",section:"([a-z]+)""#
    ).expect("la expresión es constante");
    static ref USED: regex::Regex =
        regex::Regex::new(r#""model"\s*:\s*"(claude-[a-z]+-[0-9][a-z0-9-]*)""#).expect("la expresión es constante");
}

const CHUNK: usize = 4 << 20;
/// Lo que se arrastra entre pedazos para no partir una entrada del catálogo.
const CARRY: usize = 256;

/// Las entradas del catálogo de un binario, sin las que la CLI marca como retiradas.
pub fn scan_catalog(mut source: impl Read) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let mut window: Vec<u8> = Vec::with_capacity(CHUNK + CARRY);
    loop {
        let read = match source.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        window.extend_from_slice(&buf[..read]);
        for c in CATALOG.captures_iter(&window) {
            let text = |i: usize| String::from_utf8_lossy(&c[i]).into_owned();
            if &c[3] == b"deprecated" || out.iter().any(|m| m.id == text(1)) {
                continue;
            }
            out.push(ModelInfo { id: text(1), name: Some(text(2)) });
        }
        let keep = window.len().min(CARRY);
        window.drain(..window.len() - keep);
    }
    out
}

/// Los modelos que aparecen en el final de un `.jsonl` de sesión.
pub fn used_in(tail: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in USED.captures_iter(tail) {
        let id = c[1].to_string();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Cuántas sesiones recientes se miran, y cuánto del final de cada una.
const RECENT_SESSIONS: usize = 60;
const TAIL_BYTES: u64 = 64 * 1024;

fn recently_used(projects: &std::path::Path) -> Vec<String> {
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = std::fs::read_dir(projects)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|dir| std::fs::read_dir(dir.path()).ok())
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out: Vec<String> = Vec::new();
    for (_, path) in files.into_iter().take(RECENT_SESSIONS) {
        let Ok(mut file) = std::fs::File::open(&path) else { continue };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)));
        let mut tail = String::new();
        if file.read_to_string(&mut tail).is_err() {
            // Un corte en medio de un carácter: se lee como bytes y se pasa a texto igual.
            let mut bytes = Vec::new();
            let _ = file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)));
            let _ = file.read_to_end(&mut bytes);
            tail = String::from_utf8_lossy(&bytes).into_owned();
        }
        for id in used_in(&tail) {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// Los modelos de Claude Code que se conocen en esta máquina: el catálogo de la CLI
/// instalada más los que usaron las sesiones recientes de esta cuenta.
#[tauri::command]
pub async fn chat_models(
    account_id: Option<String>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<Vec<ModelInfo>, String> {
    lazy_static::lazy_static! {
        static ref CACHE: std::sync::Mutex<std::collections::HashMap<String, Vec<ModelInfo>>> =
            std::sync::Mutex::new(std::collections::HashMap::new());
    }
    let profile = account_id.as_deref().and_then(|id| crate::accounts::dir_for(&db, id));
    tauri::async_runtime::spawn_blocking(move || {
        let mut models: Vec<ModelInfo> = Vec::new();
        // El catálogo: se cachea por binario y tamaño, recorrer 250 MB una vez por versión.
        let command = crate::agents::agent_command("claude-code").unwrap_or("claude");
        if let Some(path) = crate::util::find_program(command) {
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            if let Ok(meta) = std::fs::metadata(&path) {
                let key = format!("{}:{}", path.to_string_lossy(), meta.len());
                let hit = CACHE.lock().ok().and_then(|c| c.get(&key).cloned());
                let catalog = match hit {
                    Some(hit) => hit,
                    None => {
                        let found = std::fs::File::open(&path)
                            .map(|f| scan_catalog(std::io::BufReader::new(f)))
                            .unwrap_or_default();
                        if let Ok(mut cache) = CACHE.lock() {
                            cache.insert(key, found.clone());
                        }
                        found
                    }
                };
                models.extend(catalog);
            }
        }
        let root = profile
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".claude")));
        if let Some(root) = root {
            for id in recently_used(&root.join("projects")) {
                if !models.iter().any(|m| m.id == id) {
                    models.push(ModelInfo { id, name: None });
                }
            }
        }
        models
    })
    .await
    .map_err(|e| e.to_string())
}
