use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct SessionTitleResult {
    pub title: String,
    pub source: String,
}

fn fallback_result(fallback: &str) -> SessionTitleResult {
    SessionTitleResult { title: fallback.to_string(), source: "fallback".to_string() }
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max).collect::<String>().trim())
    }
}

fn mtime_secs(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

fn collect_files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, ext, out);
        } else if path.extension().map_or(false, |e| e == ext) {
            out.push(path);
        }
    }
}

fn newest_matching(
    candidates: &[PathBuf],
    after: Option<i64>,
    content_hint: Option<&str>,
) -> Option<PathBuf> {
    let mut scored: Vec<(PathBuf, i64, bool)> = candidates
        .iter()
        .filter_map(|p| {
            let mtime = mtime_secs(p)?;
            if let Some(after) = after {
                // ">=" y no ">": el timestamp tiene resolución de 1s, así que un archivo
                // creado en el mismo segundo en que arrancó el proceso es válido.
                if mtime < after {
                    return None;
                }
            }
            let matches_hint = content_hint
                .map(|hint| fs::read_to_string(p).map_or(false, |c| c.contains(hint)))
                .unwrap_or(false);
            Some((p.clone(), mtime, matches_hint))
        })
        .collect();

    if scored.is_empty() {
        return None;
    }

    if content_hint.is_some() && scored.iter().any(|(_, _, m)| *m) {
        scored.retain(|(_, _, m)| *m);
    }

    scored.sort_by_key(|(_, mtime, _)| *mtime);
    scored.pop().map(|(p, _, _)| p)
}

fn find_string_field(path: &Path, candidates: &[&str]) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        for c in candidates {
            if let Some(s) = v.get(*c).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = v.get("payload").and_then(|p| p.get(*c)).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = v.get("$set").and_then(|p| p.get(*c)).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn extract_text_block(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    content.as_array()?.iter().find_map(|b| {
        let t = b.get("type").and_then(|t| t.as_str())?;
        if t == "text" || t == "input_text" || t == "output_text" {
            b.get("text").and_then(|t| t.as_str()).map(String::from)
        } else {
            None
        }
    })
}

// ── Claude Code: ~/.claude/projects/<cwd con '/' -> '-'>/<uuid>.jsonl ────

fn claude_project_dir(cwd: &str) -> PathBuf {
    let slug = cwd.replace('/', "-");
    dirs::home_dir().unwrap_or_default().join(".claude/projects").join(slug)
}

fn claude_session_file(cwd: &str, session_id: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
    let dir = claude_project_dir(cwd);
    if let Some(id) = session_id {
        let direct = dir.join(format!("{id}.jsonl"));
        if direct.exists() {
            return Some(direct);
        }
    }
    let mut files = Vec::new();
    collect_files(&dir, "jsonl", &mut files);
    newest_matching(&files, after, None)
}

fn claude_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };
    let mut first_user_msg: Option<String> = None;

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("summary") {
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                return SessionTitleResult { title: truncate(s, 60), source: "summary".into() };
            }
        }
        if first_user_msg.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            first_user_msg = v.get("message").and_then(|m| m.get("content")).and_then(extract_text_block);
        }
    }

    match first_user_msg {
        Some(m) => SessionTitleResult { title: truncate(&m, 60), source: "first_message".into() },
        None => fallback_result(fallback),
    }
}

// ── Gemini CLI: ~/.gemini/tmp/<project_hash>/chats/session-*.jsonl ──────

fn gemini_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".gemini/tmp")
}

fn gemini_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_files(&gemini_root(), "jsonl", &mut files);
    newest_matching(&files, after, Some(cwd))
}

fn gemini_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };
    let mut first_user_msg: Option<String> = None;

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let summary = v.get("summary").and_then(|s| s.as_str())
            .or_else(|| v.get("$set").and_then(|s| s.get("summary")).and_then(|s| s.as_str()));
        if let Some(s) = summary {
            return SessionTitleResult { title: truncate(s, 60), source: "summary".into() };
        }
        if first_user_msg.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            first_user_msg = v.get("content").and_then(|c| c.as_str()).map(String::from);
        }
    }

    match first_user_msg {
        Some(m) => SessionTitleResult { title: truncate(&m, 60), source: "first_message".into() },
        None => fallback_result(fallback),
    }
}

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ──────────────────

fn codex_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex/sessions")
}

fn codex_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let mut files = Vec::new();
    collect_files(&codex_root(), "jsonl", &mut files);
    newest_matching(&files, after, Some(cwd))
}

fn codex_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let msg_type = v.get("type").and_then(|t| t.as_str());

        if msg_type == Some("event_msg") {
            let payload = v.get("payload");
            if payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("user_message") {
                if let Some(m) = payload.and_then(|p| p.get("message")).and_then(|m| m.as_str()) {
                    return SessionTitleResult { title: truncate(m, 60), source: "first_message".into() };
                }
            }
        }

        if msg_type == Some("response_item") {
            if v.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(text) = v.get("content").and_then(extract_text_block) {
                    return SessionTitleResult { title: truncate(&text, 60), source: "first_message".into() };
                }
            }
        }
    }

    fallback_result(fallback)
}

// ── OpenCode: ~/.local/share/opencode/storage/session/<projectID>/<id>.json ──
// ATENCIÓN: esta ruta y formato (JSON por sesión) nunca se verificaron contra la fuente
// real de OpenCode — quedaron asumidos por analogía con Claude Code. Una investigación
// posterior (ver historial) confirmó que OpenCode en realidad persiste sus sesiones en
// SQLite, no en archivos JSON sueltos — así que todo este bloque probablemente nunca
// encuentra nada real y siempre degrada a `fallback_result` (no rompe nada, pero el
// título automático / resume de OpenCode no funciona). Arreglarlo bien requiere la
// ubicación real del .db y su schema, que no pudimos confirmar. `discover_session_id`
// para "opencode" queda con este mismo problema.

fn opencode_data_dir() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".local/share"))
        .join("opencode")
}

fn opencode_project_id_for_cwd(cwd: &str) -> Option<String> {
    let project_dir = opencode_data_dir().join("storage/project");
    let mut files = Vec::new();
    collect_files(&project_dir, "json", &mut files);
    files.into_iter().find_map(|f| {
        let content = fs::read_to_string(&f).ok()?;
        if content.contains(cwd) {
            f.file_stem().map(|s| s.to_string_lossy().to_string())
        } else {
            None
        }
    })
}

fn opencode_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let session_root = opencode_data_dir().join("storage/session");
    let scoped_dir = opencode_project_id_for_cwd(cwd).map(|id| session_root.join(id));

    let mut files = Vec::new();
    match &scoped_dir {
        Some(dir) if dir.is_dir() => collect_files(dir, "json", &mut files),
        _ => collect_files(&session_root, "json", &mut files),
    }
    newest_matching(&files, after, None)
}

fn opencode_title(path: &Path, fallback: &str) -> SessionTitleResult {
    let Ok(content) = fs::read_to_string(path) else { return fallback_result(fallback) };
    let Ok(v) = serde_json::from_str::<Value>(&content) else { return fallback_result(fallback) };
    match v.get("title").and_then(|t| t.as_str()) {
        Some(t) if !t.trim().is_empty() => SessionTitleResult { title: truncate(t, 60), source: "summary".into() },
        _ => fallback_result(fallback),
    }
}

fn opencode_session_id_from_path(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().to_string())
}

// ── TUIs personalizadas ───────────────────────────────────────────────

/// Archivo de sesión más reciente de una TUI custom: el más nuevo bajo la carpeta que el
/// usuario declaró, buscando tanto `.jsonl` como `.json` (las dos formas que usan los CLIs
/// conocidos). A diferencia de las TUIs de fábrica no se filtra por cwd — no hay forma
/// genérica de saber cómo esa TUI mapea un proyecto a una carpeta — así que el filtro por
/// `after` (el momento en que arrancó ESTE proceso) es lo único que evita agarrar la
/// sesión de otra tab. Por eso `get_session_title` no lo usa sin un `after`.
fn custom_session_file(agent: &crate::agents::CustomAgent, after: Option<i64>) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    newest_matching(&files, after, None)
}

/// Archivo de la sesión con ESTE id exacto, ya sea porque el id es el nombre del archivo
/// o porque aparece adentro. Recorre la carpeta declarada; devuelve `None` si no aparece.
fn custom_session_file_by_id(
    agent: &crate::agents::CustomAgent,
    session_id: &str,
) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    files.into_iter().find(|p| custom_session_id(agent, p).as_deref() == Some(session_id))
}

fn custom_session_id(agent: &crate::agents::CustomAgent, path: &Path) -> Option<String> {
    match agent.session_id_source() {
        crate::agents::SessionIdSource::Filename => {
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }
        crate::agents::SessionIdSource::Field(key) => find_string_field(path, &[key.as_str()]),
    }
}

/// Título de una sesión de TUI custom: se reusa la heurística genérica de "primer mensaje
/// del usuario" que ya sirve para Codex, porque cubre las formas JSONL más comunes
/// (`role: user` + `content` string o bloques de texto) sin conocer el formato exacto.
fn custom_title(path: &Path, fallback: &str) -> SessionTitleResult {
    codex_title(path, fallback)
}

// ── Comandos públicos ─────────────────────────────────────────────────

/// Busca el archivo/registro de sesión más reciente para `cwd` (creado después de
/// `started_after`) y devuelve el session_id real que el agente le asignó, para poder
/// reanudarlo más adelante con la flag de resume de cada CLI.
#[tauri::command]
pub fn discover_session_id(
    agent_id: String,
    cwd: String,
    started_after: i64,
    db: tauri::State<crate::database::DbConnection>,
) -> Option<String> {
    match agent_id.as_str() {
        "claude-code" => {
            let path = claude_session_file(&cwd, None, Some(started_after))?;
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }
        "gemini-cli" => {
            let path = gemini_session_file(&cwd, Some(started_after))?;
            find_string_field(&path, &["sessionId", "session_id"])
        }
        "codex" => {
            let path = codex_session_file(&cwd, Some(started_after))?;
            find_string_field(&path, &["session_id", "id"])
        }
        "opencode" => {
            let path = opencode_session_file(&cwd, Some(started_after))?;
            opencode_session_id_from_path(&path)
        }
        // TUI custom: solo si el usuario declaró dónde guarda sus sesiones.
        other => {
            let conn = db.lock().ok()?;
            let agent = crate::agents::find(&conn, other)?;
            drop(conn);
            let path = custom_session_file(&agent, Some(started_after))?;
            custom_session_id(&agent, &path)
        }
    }
}

/// Genera un título legible para la tab a partir de la sesión real del agente.
/// Si el agente no es soportado o no se encuentra la sesión, devuelve `fallback`.
#[tauri::command]
pub fn get_session_title(
    agent_id: String,
    cwd: String,
    session_id: Option<String>,
    fallback: String,
    db: tauri::State<crate::database::DbConnection>,
) -> SessionTitleResult {
    match agent_id.as_str() {
        "claude-code" => match claude_session_file(&cwd, session_id.as_deref(), None) {
            Some(path) => claude_title(&path, &fallback),
            None => fallback_result(&fallback),
        },
        "gemini-cli" => match gemini_session_file(&cwd, None) {
            Some(path) => gemini_title(&path, &fallback),
            None => fallback_result(&fallback),
        },
        "codex" => match codex_session_file(&cwd, None) {
            Some(path) => codex_title(&path, &fallback),
            None => fallback_result(&fallback),
        },
        "opencode" => match opencode_session_file(&cwd, None) {
            Some(path) => opencode_title(&path, &fallback),
            None => fallback_result(&fallback),
        },
        // TUI custom: se busca el archivo por su id exacto, nunca "el más reciente" — sin
        // saber cómo esa TUI mapea proyectos a carpetas, "el más reciente" podría ser la
        // sesión de otra tab y el título quedaría cruzado.
        other => {
            let Some(id) = session_id else { return fallback_result(&fallback) };
            let Ok(conn) = db.lock() else { return fallback_result(&fallback) };
            let Some(agent) = crate::agents::find(&conn, other) else {
                return fallback_result(&fallback);
            };
            drop(conn);
            match custom_session_file_by_id(&agent, &id) {
                Some(path) => custom_title(&path, &fallback),
                None => fallback_result(&fallback),
            }
        }
    }
}
