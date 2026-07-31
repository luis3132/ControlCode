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
        } else if path.extension().is_some_and(|e| e == ext) {
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
                .map(|hint| fs::read_to_string(p).is_ok_and(|c| c.contains(hint)))
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

        if msg_type == Some("response_item")
            && v.get("role").and_then(|r| r.as_str()) == Some("user")
        {
            if let Some(text) = v.get("content").and_then(extract_text_block) {
                return SessionTitleResult { title: truncate(&text, 60), source: "first_message".into() };
            }
        }
    }

    fallback_result(fallback)
}

// ── OpenCode: vía su propia CLI, no leyendo su almacenamiento ─────────
//
// Los otros agentes se resuelven leyendo los archivos de sesión que dejan en disco. Con
// OpenCode eso no funciona: la implementación anterior asumía
// `~/.local/share/opencode/storage/session/<projectID>/<id>.json` por analogía con Claude
// Code, nunca se verificó, y no encontraba nada — el título automático y el resume de
// OpenCode simplemente no funcionaban.
//
// OpenCode expone `session list --format json`, que es contrato público y documentado
// (opencode.ai/docs/cli), así que se le pregunta a él en vez de espiarle los archivos.
// Verificado contra la v1.18.4 instalada; cada entrada trae exactamente lo que hace falta:
//
//   { "id": "ses_…", "title": "…", "created": 1782913776585,
//     "updated": …, "projectId": "…", "directory": "/ruta/del/proyecto" }
//
// `directory` es lo que permite filtrar por cwd sin tener que resolver el projectId a mano,
// y los timestamps vienen en MILISEGUNDOS (el resto del módulo trabaja en segundos).

/// Ventana de tolerancia al comparar el `created` de una sesión contra el arranque de la
/// tab: OpenCode sella la sesión cuando el usuario manda el primer mensaje, no cuando
/// arranca el proceso, pero un reloj con desfase no debería descartar una sesión legítima.
const OPENCODE_CLOCK_SKEW_S: i64 = 5;

#[derive(serde::Deserialize)]
struct OpencodeSession {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    directory: String,
    #[serde(default)]
    created: i64,
}

/// Sesiones de OpenCode para un cwd, de la más reciente a la más vieja.
///
/// Se acota con `-n` en vez de traer todo el historial: solo interesan las últimas, y cada
/// llamada levanta un proceso que abre la base de datos entera de OpenCode (~0.9 s medido
/// contra la v1.18.4), así que no conviene pedir de más.
///
/// `current_dir` no es cosmético: `opencode session list` está acotado por proyecto según
/// el directorio desde el que corre. Ejecutado desde otro lado devuelve las sesiones de
/// OTRO proyecto — verificado: desde `/tmp` lista las del proyecto `global`, no las de
/// este cwd. El filtro por `directory` de abajo es la segunda red.
///
/// Cada fallo se reporta por stderr en vez de degradar en silencio: sin eso, "no aparece
/// la sesión" es indistinguible de "opencode no está en el PATH del proceso de la app",
/// que es un caso real cuando la app se lanza desde el menú del escritorio y no desde una
/// terminal (el PATH del launcher no incluye `~/.opencode/bin`).
fn opencode_sessions(cwd: &str) -> Vec<OpencodeSession> {
    let output = match std::process::Command::new("opencode")
        .args(["session", "list", "--format", "json", "-n", "50"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[opencode] no se pudo ejecutar `opencode session list`: {e}");
            return Vec::new();
        }
    };
    if !output.status.success() {
        eprintln!(
            "[opencode] `session list` salió con {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return Vec::new();
    }

    // El banner informativo de OpenCode va a stderr, así que stdout es JSON puro.
    let mut sessions: Vec<OpencodeSession> = match serde_json::from_slice(&output.stdout) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[opencode] salida de `session list` ilegible: {e}");
            return Vec::new();
        }
    };

    let total = sessions.len();
    sessions.retain(|s| Path::new(&s.directory) == Path::new(cwd));
    if sessions.is_empty() && total > 0 {
        eprintln!(
            "[opencode] {total} sesión(es) devueltas pero ninguna con directory == {cwd}"
        );
    }
    sessions.sort_by(|a, b| b.created.cmp(&a.created));
    sessions
}

/// Sesión más reciente del cwd, opcionalmente creada después de `after` (en segundos).
fn opencode_session(cwd: &str, after: Option<i64>) -> Option<OpencodeSession> {
    let sessions = opencode_sessions(cwd);
    let found = sessions.into_iter().find(|s| match after {
        // `created` viene en MILISEGUNDOS; el resto del módulo trabaja en segundos.
        Some(t) => s.created / 1000 >= t - OPENCODE_CLOCK_SKEW_S,
        None => true,
    });
    if found.is_none() {
        if let Some(t) = after {
            eprintln!("[opencode] ninguna sesión de {cwd} creada después de {t}");
        }
    }
    found
}

/// OpenCode nombra las sesiones `New session - <ISO>` hasta que el modelo les pone un
/// título real. Ese placeholder no le dice nada al usuario en la barra de tabs, así que se
/// trata como "todavía no hay título" y se deja el fallback (el comando se reintenta más
/// adelante y para entonces suele estar el bueno).
fn opencode_is_placeholder_title(title: &str) -> bool {
    title.trim_start().starts_with("New session -")
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

/// Archivo de sesión de una entrada del historial, resolviendo por el camino propio de
/// cada agente. A diferencia de `get_session_title`, acá interesa el archivo en sí (para
/// leer la conversación entera), y se acepta el "más reciente del cwd" cuando no hay
/// `session_id`: en un export, mostrar la sesión más probable es mejor que no mostrar nada.
pub fn session_file_for(
    agent_id: &str,
    cwd: &str,
    session_id: Option<&str>,
    db: &tauri::State<crate::database::DbConnection>,
) -> Option<PathBuf> {
    match agent_id {
        "claude-code" => claude_session_file(cwd, session_id, None),
        "gemini-cli" => gemini_session_file(cwd, None),
        "codex" => codex_session_file(cwd, None),
        // OpenCode no expone un archivo de sesión legible; su transcripción se pide con
        // `opencode export <id>` y la maneja `export::opencode_transcript` aparte.
        "opencode" => None,
        other => {
            let conn = db.lock().ok()?;
            let agent = crate::agents::find(&conn, other)?;
            drop(conn);
            match session_id {
                Some(id) => custom_session_file_by_id(&agent, id),
                None => custom_session_file(&agent, None),
            }
        }
    }
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
        "opencode" => opencode_session(&cwd, Some(started_after)).map(|s| s.id),
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
        // Se busca por id exacto cuando se conoce: "la más reciente del cwd" podría ser la
        // de otra tab abierta en la misma carpeta y el título quedaría cruzado.
        "opencode" => {
            let found = match session_id.as_deref() {
                Some(id) => opencode_sessions(&cwd).into_iter().find(|s| s.id == id),
                None => opencode_session(&cwd, None),
            };
            match found {
                Some(s) if !s.title.trim().is_empty() && !opencode_is_placeholder_title(&s.title) => {
                    SessionTitleResult { title: truncate(&s.title, 60), source: "summary".into() }
                }
                _ => fallback_result(&fallback),
            }
        }
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
