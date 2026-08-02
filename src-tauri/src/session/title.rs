use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
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

/// Primera línea de un archivo, parseada como JSON.
///
/// Existe para no tener que leer el archivo entero cuando lo único que interesa es la
/// cabecera: los rollouts de Codex arrancan con una línea `session_meta` que ya trae el id
/// y el cwd de la sesión, y esos archivos crecen con la conversación entera (tool calls,
/// diffs, salidas de comandos). `read_to_string` sobre TODOS los rollouts del sistema, en
/// cada intento de descubrimiento, es justamente el I/O que hay que evitar.
fn first_line_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// El más nuevo (por mtime) de los candidatos que pasen `keep`, respetando el piso `after`.
///
/// Variante de `newest_matching` para los agentes cuyo filtro NO es "el cwd aparece en
/// algún lado del archivo" sino una condición que se puede decidir leyendo solo metadata.
fn newest_where(
    candidates: &[PathBuf],
    after: Option<i64>,
    keep: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates
        .iter()
        .filter_map(|p| {
            let mtime = mtime_secs(p)?;
            // ">=" y no ">" por el mismo motivo que en `newest_matching`: el mtime tiene
            // resolución de 1s y el archivo puede nacer en el mismo segundo del arranque.
            if after.is_some_and(|a| mtime < a) {
                return None;
            }
            keep(p).then(|| (p.clone(), mtime))
        })
        .max_by_key(|(_, mtime)| *mtime)
        .map(|(p, _)| p)
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

/// Texto de un `content`, que cada CLI modela distinto: string plano, un bloque suelto o
/// una lista. Los bloques de Claude/Codex vienen tipados (`text`/`input_text`/`output_text`);
/// los `Part` de Gemini NO tienen `type`, solo `text` — sin contemplarlos, el título de una
/// sesión de Gemini nunca sale del primer mensaje.
fn extract_text_block(content: &Value) -> Option<String> {
    fn text_of_block(b: &Value) -> Option<String> {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") | Some("input_text") | Some("output_text") => {
                b.get("text").and_then(|t| t.as_str()).map(String::from)
            }
            // Bloque tipado de otra cosa (tool_use, thought…): no es texto de la conversación.
            Some(_) => None,
            // Sin `type`: es un Part de Gemini, donde `text` es el contenido.
            None => b.get("text").and_then(|t| t.as_str()).map(String::from),
        }
    }

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    match content.as_array() {
        Some(blocks) => blocks.iter().find_map(text_of_block),
        None => text_of_block(content),
    }
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

// ── Gemini CLI: ~/.gemini/tmp/<slug>/chats/session-*.jsonl ───────────────
//
// Gemini le asigna a cada proyecto una carpeta bajo `~/.gemini/tmp/`. El nombre NO es un
// hash: es un slug legible del basename del proyecto (`mi-proyecto`, `mi-proyecto-1` si
// choca), asignado por su ProjectRegistry. Como el slug se reparte por orden de llegada,
// no se puede derivar del cwd — hay que consultarlo. Gemini deja DOS formas de hacerlo:
//
//   ~/.gemini/projects.json          {"projects": {"/ruta/abs": "slug"}}
//   ~/.gemini/tmp/<slug>/.project_root   contiene la ruta absoluta del proyecto
//
// Adentro, la conversación vive en `<slug>/chats/session-<YYYY-MM-DDTHH-mm>-<8>.jsonl`,
// cuya PRIMERA línea es la metadata de la sesión:
//
//   {"sessionId":"…","projectHash":"…","startTime":"…","lastUpdated":"…",
//    "kind":"main"|"subagent","summary":"…"}
//
// Antes esto se resolvía escaneando TODO `~/.gemini/tmp` y quedándose con el archivo más
// nuevo que CONTUVIERA el cwd como substring. Eso traía tres problemas, los tres reales:
//
//   1. `contains` da falso positivo por prefijo — una tab de `/home/u/proj` podía quedarse
//      con la sesión de `/home/u/proj2` y reanudar la conversación de otro proyecto.
//   2. Los sub-agentes escriben su propio `.jsonl` en la misma carpeta con
//      `kind: "subagent"`. Al ser el más nuevo, la tab podía adoptar el id de un sub-agente
//      en vez del de la sesión principal, y `--resume` con ese id no reanuda la charla.
//   3. Leía el contenido completo de todos los archivos de sesión del sistema en cada
//      intento de descubrimiento (cada 3s), no solo los de este proyecto.

fn gemini_home() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".gemini")
}

/// Carpeta que Gemini le asignó a este cwd, o `None` si nunca abrió una sesión acá.
fn gemini_project_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
    let tmp = home.join("tmp");

    // 1) El registro, que es el mapa autoritativo proyecto → slug.
    if let Ok(raw) = fs::read_to_string(home.join("projects.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(projects) = v.get("projects").and_then(|p| p.as_object()) {
                if let Some(slug) =
                    projects.iter().find(|(k, _)| Path::new(k.as_str()) == Path::new(cwd))
                        .and_then(|(_, v)| v.as_str())
                {
                    let dir = tmp.join(slug);
                    if dir.is_dir() {
                        return Some(dir);
                    }
                }
            }
        }
    }

    // 2) Los marcadores `.project_root`, que Gemini escribe justamente para poder verificar
    //    a qué proyecto pertenece cada slug. Cubre el caso de un registro desincronizado.
    let entries = fs::read_dir(&tmp).ok()?;
    entries.flatten().map(|e| e.path()).find(|dir| {
        fs::read_to_string(dir.join(".project_root"))
            .is_ok_and(|owner| Path::new(owner.trim()) == Path::new(cwd))
    })
}

/// Metadata de la primera línea de un archivo de chat.
struct GeminiMeta {
    session_id: Option<String>,
    kind: Option<String>,
}

fn gemini_meta(path: &Path) -> Option<GeminiMeta> {
    let v = first_line_json(path)?;
    // `sessionId` es obligatorio en la cabecera; si no está, esta no es una cabecera.
    let session_id = v.get("sessionId").and_then(|s| s.as_str()).map(String::from)?;
    Some(GeminiMeta {
        session_id: Some(session_id),
        kind: v.get("kind").and_then(|k| k.as_str()).map(String::from),
    })
}

/// Una sesión de sub-agente no es la conversación de la tab: reanudarla con `--resume`
/// no devuelve al usuario a su charla. `kind` ausente se trata como principal, que es el
/// comportamiento de las versiones que todavía no escribían el campo.
fn gemini_is_main_session(path: &Path) -> bool {
    match gemini_meta(path) {
        Some(m) => m.kind.as_deref() != Some("subagent"),
        None => false,
    }
}

fn gemini_chat_files(home: &Path, cwd: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(dir) = gemini_project_dir(home, cwd) {
        collect_files(&dir.join("chats"), "jsonl", &mut files);
    }
    files
}

fn gemini_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    gemini_session_file_in(&gemini_home(), cwd, after)
}

fn gemini_session_file_in(home: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let files = gemini_chat_files(home, cwd);
    if !files.is_empty() {
        return newest_where(&files, after, gemini_is_main_session);
    }

    // No se pudo ubicar la carpeta del proyecto (instalación vieja con carpetas por hash,
    // registro ilegible, permisos). Se degrada al escaneo global de antes en vez de dejar de
    // funcionar — pero con el cwd entre comillas, que dentro de un JSON delimita el valor y
    // evita el falso positivo por prefijo.
    let mut all = Vec::new();
    collect_files(&home.join("tmp"), "jsonl", &mut all);
    newest_matching(&all, after, Some(&format!("\"{cwd}\"")))
}

fn gemini_session_file_by_id(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    gemini_chat_files(home, cwd)
        .into_iter()
        .find(|p| gemini_meta(p).and_then(|m| m.session_id).as_deref() == Some(session_id))
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
        // El contenido es un PartListUnion, no un string: `as_str()` solo cubría el caso
        // más raro (string pelado) y dejaba afuera el habitual, `[{"text": "…"}]`.
        if first_user_msg.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            first_user_msg = v.get("content").and_then(extract_text_block);
        }
    }

    match first_user_msg {
        Some(m) => SessionTitleResult { title: truncate(&m, 60), source: "first_message".into() },
        None => fallback_result(fallback),
    }
}

// ── Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl ───────────────
//
// Cada rollout es un JSONL cuya PRIMERA línea es la cabecera de la sesión:
//
//   {"timestamp":"…","type":"session_meta",
//    "payload":{"id":"…","cwd":"/ruta","source":"cli","cli_version":"…","git":{…}}}
//
// y las siguientes son `response_item` / `event_msg` / `turn_context` / … con el mismo
// envoltorio `{timestamp, type, payload}`.
//
// Eso hace que el id y el cwd de la sesión se puedan leer SIN abrir el archivo entero,
// que es lo que hacía la versión anterior: filtraba con `newest_matching(.., Some(cwd))`,
// o sea `read_to_string` + `contains(cwd)` sobre TODOS los rollouts del sistema, en cada
// intento de descubrimiento (cada 3s al principio). Con historial acumulado eso es leer
// megabytes de conversaciones para resolver una tab.
//
// Además `contains` daba falsos positivos por prefijo: el cwd `/home/u/proj` está
// contenido en cualquier rollout de `/home/u/proj2`, así que una tab podía adoptar el
// session id de OTRO proyecto y reanudar la conversación equivocada. Comparar `payload.cwd`
// como ruta, y no como substring, elimina las dos cosas.

fn codex_root() -> PathBuf {
    // Codex respeta CODEX_HOME para reubicar toda su configuración y su historial; si no
    // está definida cae en ~/.codex.
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
    home.join("sessions")
}

/// Cabecera `session_meta` de un rollout: lo que hace falta para identificar la sesión sin
/// leer la conversación. `None` si el archivo no arranca con una cabecera reconocible.
struct CodexMeta {
    id: Option<String>,
    cwd: PathBuf,
}

fn codex_meta(path: &Path) -> Option<CodexMeta> {
    let v = first_line_json(path)?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    Some(CodexMeta {
        id: payload.get("id").and_then(|i| i.as_str()).map(String::from),
        cwd: PathBuf::from(payload.get("cwd").and_then(|c| c.as_str())?),
    })
}

fn codex_rollouts_in(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files(root, "jsonl", &mut files);
    files
}

fn codex_rollouts() -> Vec<PathBuf> {
    codex_rollouts_in(&codex_root())
}

/// Rollout de la sesión con ESTE id exacto. Se prefiere a "el más nuevo del cwd" cuando el
/// id se conoce: con dos tabs de Codex abiertas en la misma carpeta, "el más nuevo" es el de
/// la otra tab y los títulos quedarían cruzados.
fn codex_session_file_by_id(session_id: &str) -> Option<PathBuf> {
    codex_rollouts()
        .into_iter()
        .find(|p| codex_meta(p).and_then(|m| m.id).as_deref() == Some(session_id))
}

fn codex_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    codex_session_file_in(&codex_root(), cwd, after)
}

fn codex_session_file_in(root: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    let files = codex_rollouts_in(root);
    if let Some(found) =
        newest_where(&files, after, |p| codex_meta(p).is_some_and(|m| m.cwd == Path::new(cwd)))
    {
        return Some(found);
    }

    // Ningún rollout declaró este cwd en su cabecera. Puede ser que no haya sesión (caso
    // normal, y entonces el fallback tampoco encuentra nada), o que una versión de Codex
    // cambie el formato de la cabecera — en ese caso se degrada al escaneo por contenido
    // de antes en vez de dejar de funcionar del todo.
    //
    // El hint va entre comillas (`"/ruta"`) y no pelado: dentro de un JSON el valor está
    // delimitado, así que exigir las comillas evita el falso positivo por prefijo
    // (`/home/u/proj` contra un rollout de `/home/u/proj2`).
    if !files.is_empty() && files.iter().any(|p| codex_meta(p).is_some()) {
        // Hay cabeceras legibles y ninguna es de este cwd: la respuesta es "no hay sesión",
        // no hace falta el fallback caro.
        return None;
    }
    newest_matching(&files, after, Some(&format!("\"{cwd}\"")))
}

/// Codex arranca toda sesión inyectando contexto sintético como si fuera del usuario
/// (`<environment_context>` con el cwd/OS/sandbox, `<user_instructions>` con el AGENTS.md).
/// Eso no lo escribió la persona: como título de tab sería siempre el mismo bloque de XML,
/// y en el export ensuciaría el arranque de la conversación.
fn codex_is_synthetic(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("## My environment")
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
                    if !codex_is_synthetic(m) {
                        return SessionTitleResult {
                            title: truncate(m, 60),
                            source: "first_message".into(),
                        };
                    }
                }
            }
        }

        // El rol vive en `payload` (el envoltorio de la línea solo trae timestamp/type),
        // pero se acepta también en la raíz: los rollouts viejos guardaban el response_item
        // plano, sin envolver.
        if msg_type == Some("response_item") {
            let body = v.get("payload").unwrap_or(&v);
            if body.get("role").and_then(|r| r.as_str()) == Some("user") {
                if let Some(text) = body.get("content").and_then(extract_text_block) {
                    if !codex_is_synthetic(&text) {
                        return SessionTitleResult {
                            title: truncate(&text, 60),
                            source: "first_message".into(),
                        };
                    }
                }
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

// ── Kimi Code: $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ ────────
//
// Kimi ya figuraba como agente detectable y con comando de resume (`--session <id>`), pero
// NO tenía implementación de sesiones: caía en la rama `other`, que busca el agente en la
// tabla de TUIs custom, no lo encontraba (es de fábrica, no custom) y devolvía `None`.
// O sea que el id nunca se descubría, el título nunca salía y el resume nunca se armaba:
// el soporte era nominal.
//
// Layout documentado (kimi.com/code/docs → Data locations):
//
//   sessions/<workDirKey>/<sessionId>/state.json            ← metadata (title, lastPrompt…)
//   sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl ← stream del agente principal
//
// `workDirKey` es `wd_<slug>_<primeros-12-de-sha256>`, pero la doc NO especifica qué string
// exacto se hashea ni cómo se arma el slug. Reconstruirlo a ojo sería adivinar, y adivinar
// mal significa no encontrar NINGUNA sesión — así que no se reconstruye: se recorren los
// buckets y se identifica la sesión por su propia metadata. El id es el nombre de la
// carpeta, que sí es contrato observable.
const KIMI_CWD_FIELDS: &[&str] =
    &["workDir", "workingDirectory", "cwd", "directory", "projectRoot", "work_dir", "root"];

fn kimi_root() -> PathBuf {
    let home = std::env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".kimi-code"));
    home.join("sessions")
}

/// Carpetas de sesión: los nietos de `sessions/` que tengan un `state.json`.
/// Se camina en dos niveles exactos en vez de recursivamente porque adentro de cada sesión
/// hay muchos más `.json` (`upcoming-goals.json`, `agents/*/plans/*`) que no son sesiones.
fn kimi_session_dirs() -> Vec<PathBuf> {
    kimi_session_dirs_in(&kimi_root())
}

fn kimi_session_dirs_in(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Ok(buckets) = fs::read_dir(root) else { return dirs };
    for bucket in buckets.flatten() {
        let Ok(sessions) = fs::read_dir(bucket.path()) else { continue };
        for session in sessions.flatten() {
            let dir = session.path();
            if dir.join("state.json").is_file() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

fn kimi_state(dir: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(dir.join("state.json")).ok()?).ok()
}

/// El id de la sesión es el nombre de su carpeta — que es lo que espera `kimi --session`.
fn kimi_session_id(dir: &Path) -> Option<String> {
    dir.file_name().map(|s| s.to_string_lossy().to_string())
}

/// Directorio de trabajo declarado en `state.json`, si lo declara.
///
/// La doc lista los campos de `state.json` como "title, lastPrompt, timestamps, forkedFrom"
/// sin enumerarlos todos, así que no está garantizado que el cwd esté ahí. Devolver `None`
/// cuando no aparece es deliberado: el llamador entonces NO filtra por cwd en vez de
/// filtrar con un criterio inventado y quedarse sin resultados.
fn kimi_declared_cwd(state: &Value) -> Option<PathBuf> {
    KIMI_CWD_FIELDS
        .iter()
        .find_map(|k| state.get(*k).and_then(|v| v.as_str()))
        .map(PathBuf::from)
}

/// Sesión más reciente, filtrando por cwd solo si `state.json` lo declara.
///
/// El orden es por mtime del `state.json` (se reescribe en cada turno). Cuando el cwd no se
/// puede confirmar, el piso `after` — el arranque de ESTA tab — es lo único que separa esta
/// sesión de la de otra tab, igual que con las TUIs custom.
fn kimi_session_dir(cwd: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
    kimi_session_dir_in(&kimi_root(), cwd, after)
}

fn kimi_session_dir_in(root: &Path, cwd: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
    let states: Vec<PathBuf> =
        kimi_session_dirs_in(root).into_iter().map(|d| d.join("state.json")).collect();

    let matches_cwd = |state_path: &Path| -> bool {
        let Some(cwd) = cwd else { return true };
        match kimi_state(state_path.parent().unwrap_or(state_path)).as_ref().and_then(kimi_declared_cwd) {
            Some(declared) => declared == Path::new(cwd),
            // Sin cwd declarado no se puede descartar: se acepta y decide `after`.
            None => true,
        }
    };

    newest_where(&states, after, matches_cwd)
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn kimi_session_dir_by_id(session_id: &str) -> Option<PathBuf> {
    kimi_session_dirs().into_iter().find(|d| kimi_session_id(d).as_deref() == Some(session_id))
}

/// `agents/main/wire.jsonl` es el stream del agente principal — la conversación. Los
/// `agents/agent-N/` son sub-agentes y no van al export.
fn kimi_wire_file(dir: &Path) -> Option<PathBuf> {
    let wire = dir.join("agents/main/wire.jsonl");
    wire.is_file().then_some(wire)
}

/// Título de una sesión de Kimi. A diferencia del resto de los agentes no hay que deducirlo
/// del primer mensaje: Kimi lo guarda en `state.json` (y el usuario puede fijarlo a mano con
/// `/title`). `lastPrompt` es el respaldo cuando todavía no le puso título.
fn kimi_title(dir: &Path, fallback: &str) -> SessionTitleResult {
    let Some(state) = kimi_state(dir) else { return fallback_result(fallback) };

    for (key, source) in [("title", "summary"), ("lastPrompt", "first_message")] {
        if let Some(s) = state.get(key).and_then(|v| v.as_str()) {
            if !s.trim().is_empty() {
                return SessionTitleResult { title: truncate(s, 60), source: source.into() };
            }
        }
    }
    fallback_result(fallback)
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
        "gemini-cli" => match session_id {
            Some(id) => gemini_session_file_by_id(&gemini_home(), cwd, id),
            None => gemini_session_file(cwd, None),
        },
        "codex" => codex_session_file(cwd, None),
        // OpenCode no expone un archivo de sesión legible; su transcripción se pide con
        // `opencode export <id>` y la maneja `export::opencode_transcript` aparte.
        "opencode" => None,
        // Kimi guarda la conversación en el wire del agente principal, no en un archivo
        // por sesión: se resuelve primero la carpeta y de ahí se baja al `wire.jsonl`.
        "kimi-code" => {
            let dir = match session_id {
                Some(id) => kimi_session_dir_by_id(id),
                None => kimi_session_dir(Some(cwd), None),
            }?;
            kimi_wire_file(&dir)
        }
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
            // `sessionId` está en la cabecera; `find_string_field` queda de respaldo por si
            // una versión emite el archivo sin ella.
            gemini_meta(&path)
                .and_then(|m| m.session_id)
                .or_else(|| find_string_field(&path, &["sessionId", "session_id"]))
        }
        "codex" => {
            let path = codex_session_file(&cwd, Some(started_after))?;
            // La cabecera `session_meta` trae el id; `find_string_field` queda como respaldo
            // por si una versión emite el rollout sin cabecera reconocible.
            codex_meta(&path)
                .and_then(|m| m.id)
                .or_else(|| find_string_field(&path, &["session_id", "id"]))
        }
        "opencode" => opencode_session(&cwd, Some(started_after)).map(|s| s.id),
        "kimi-code" => {
            let dir = kimi_session_dir(Some(&cwd), Some(started_after))?;
            kimi_session_id(&dir)
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
        "gemini-cli" => {
            let found = match session_id.as_deref() {
                Some(id) => gemini_session_file_by_id(&gemini_home(), &cwd, id),
                None => gemini_session_file(&cwd, None),
            };
            match found {
                Some(path) => gemini_title(&path, &fallback),
                None => fallback_result(&fallback),
            }
        }
        "codex" => {
            let found = match session_id.as_deref() {
                Some(id) => codex_session_file_by_id(id),
                None => codex_session_file(&cwd, None),
            };
            match found {
                Some(path) => codex_title(&path, &fallback),
                None => fallback_result(&fallback),
            }
        }
        "kimi-code" => {
            let found = match session_id.as_deref() {
                Some(id) => kimi_session_dir_by_id(id),
                None => kimi_session_dir(Some(&cwd), None),
            };
            match found {
                Some(dir) => kimi_title(&dir, &fallback),
                None => fallback_result(&fallback),
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Ninguno de los dos CLIs está instalado en la máquina de desarrollo, así que estos
    /// tests son la única verificación posible: reproducen en disco el layout documentado
    /// de cada uno y comprueban que el código lo lee. No prueban que la documentación sea
    /// fiel al binario — eso solo lo confirma un Codex/Kimi real.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("cc-title-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn write(&self, rel: &str, body: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Cabecera real de un rollout de Codex, tal como la documenta el formato:
    /// `{timestamp, type: "session_meta", payload: {id, cwd, …}}`.
    fn codex_rollout(id: &str, cwd: &str, body: &str) -> String {
        format!(
            "{}\n{}",
            serde_json::json!({
                "timestamp": "2026-08-03T10:00:00Z",
                "type": "session_meta",
                "payload": { "id": id, "cwd": cwd, "source": "cli", "cli_version": "0.55.0" }
            }),
            body
        )
    }

    #[test]
    fn codex_reads_id_and_cwd_from_the_session_meta_header() {
        let d = TempDir::new();
        let path = d.write("2026/08/03/rollout-a.jsonl", &codex_rollout("sess-a", "/proj", ""));

        let meta = codex_meta(&path).expect("la cabecera documentada debe parsearse");
        assert_eq!(meta.id.as_deref(), Some("sess-a"));
        assert_eq!(meta.cwd, Path::new("/proj"));
    }

    /// La regresión que motivó el cambio: el filtro anterior era `contenido.contains(cwd)`,
    /// y `/proj` está contenido en `/proj2`, así que una tab de `/proj` podía adoptar el
    /// session id de `/proj2` y reanudar la conversación de otro proyecto.
    #[test]
    fn codex_does_not_confuse_a_cwd_with_another_that_has_it_as_prefix() {
        let d = TempDir::new();
        d.write("2026/08/03/rollout-otro.jsonl", &codex_rollout("sess-otro", "/proj2", ""));

        assert_eq!(codex_session_file_in(&d.0, "/proj", None), None);

        let mine = d.write("2026/08/03/rollout-mio.jsonl", &codex_rollout("sess-mio", "/proj", ""));
        assert_eq!(codex_session_file_in(&d.0, "/proj", None), Some(mine));
    }

    #[test]
    fn codex_finds_a_rollout_by_its_exact_session_id() {
        let d = TempDir::new();
        d.write("2026/08/03/a.jsonl", &codex_rollout("sess-a", "/proj", ""));
        let b = d.write("2026/08/03/b.jsonl", &codex_rollout("sess-b", "/proj", ""));

        // Se busca por id y no por "el más nuevo del cwd": con dos tabs en la misma carpeta
        // el más nuevo es el de la otra tab.
        let found = codex_rollouts_in(&d.0)
            .into_iter()
            .find(|p| codex_meta(p).and_then(|m| m.id).as_deref() == Some("sess-b"));
        assert_eq!(found, Some(b));
    }

    /// Codex se inyecta contexto propio con `role: "user"` al abrir la sesión. Si eso contara
    /// como "primer mensaje", TODAS las tabs de Codex se llamarían `<environment_context>`.
    #[test]
    fn codex_title_skips_the_context_codex_injects_as_the_user() {
        let d = TempDir::new();
        let body = concat!(
            r#"{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\n  cwd: /proj\n</environment_context>"}]}}"#,
            "\n",
            r#"{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<user_instructions>usá tabs</user_instructions>"}]}}"#,
            "\n",
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"arreglá el parser"}}"#,
        );
        let path = d.write("r.jsonl", &codex_rollout("sess-a", "/proj", body));

        let result = codex_title(&path, "sin título");
        assert_eq!(result.title, "arreglá el parser");
        assert_eq!(result.source, "first_message");
    }

    #[test]
    fn codex_falls_back_to_the_fallback_when_there_is_no_real_message() {
        let d = TempDir::new();
        let path = d.write("r.jsonl", &codex_rollout("sess-a", "/proj", ""));
        assert_eq!(codex_title(&path, "sin título").title, "sin título");
    }

    // ── Kimi Code ────────────────────────────────────────────────────

    /// Layout documentado: `sessions/<workDirKey>/<sessionId>/state.json`.
    #[test]
    fn kimi_discovers_the_session_id_from_the_directory_name() {
        let d = TempDir::new();
        d.write(
            "wd_proj_0123456789ab/ses-42/state.json",
            r#"{"title":"Refactor del parser","workDir":"/proj"}"#,
        );

        let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).expect("debe encontrarla");
        assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-42"));
        assert_eq!(kimi_title(&dir, "sin título").title, "Refactor del parser");
    }

    /// El id es el nombre de la carpeta, no un campo: es lo que espera `kimi --session <id>`.
    #[test]
    fn kimi_filters_by_declared_cwd_when_state_declares_one() {
        let d = TempDir::new();
        d.write("wd_a_1/ses-a/state.json", r#"{"title":"A","workDir":"/otro"}"#);
        d.write("wd_b_2/ses-b/state.json", r#"{"title":"B","workDir":"/proj"}"#);

        let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).unwrap();
        assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-b"));
    }

    /// La doc no garantiza que `state.json` traiga el cwd. Cuando no lo trae, el filtro por
    /// cwd no debe descartar la sesión — si lo hiciera, Kimi quedaría igual de roto que antes.
    #[test]
    fn kimi_keeps_sessions_that_do_not_declare_a_cwd() {
        let d = TempDir::new();
        d.write("wd_x_1/ses-x/state.json", r#"{"title":"Sin cwd"}"#);

        let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).expect("no se debe descartar");
        assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-x"));
    }

    #[test]
    fn kimi_uses_last_prompt_when_there_is_no_title_yet() {
        let d = TempDir::new();
        d.write("wd_x_1/ses-x/state.json", r#"{"title":"","lastPrompt":"corré los tests"}"#);
        let dir = kimi_session_dir_in(&d.0, None, None).unwrap();

        let result = kimi_title(&dir, "sin título");
        assert_eq!(result.title, "corré los tests");
        assert_eq!(result.source, "first_message");
    }

    /// Adentro de una sesión hay varios `.json` que NO son sesiones (`upcoming-goals.json`,
    /// planes de agentes). Solo cuenta como sesión la carpeta con `state.json` propio.
    #[test]
    fn kimi_ignores_files_that_are_not_session_state() {
        let d = TempDir::new();
        d.write("wd_x_1/ses-x/state.json", r#"{"title":"Real"}"#);
        d.write("wd_x_1/ses-x/upcoming-goals.json", r#"{"goals":[]}"#);
        d.write("wd_x_1/ses-x/agents/main/plans/p1.json", r#"{"plan":"algo"}"#);

        assert_eq!(kimi_session_dirs_in(&d.0).len(), 1);
    }

    #[test]
    fn kimi_points_the_transcript_at_the_main_agent_wire() {
        let d = TempDir::new();
        d.write("wd_x_1/ses-x/state.json", r#"{"title":"Real"}"#);
        let wire = d.write("wd_x_1/ses-x/agents/main/wire.jsonl", "");
        d.write("wd_x_1/ses-x/agents/agent-0/wire.jsonl", "");

        let dir = kimi_session_dir_in(&d.0, None, None).unwrap();
        assert_eq!(kimi_wire_file(&dir), Some(wire));
    }

    #[test]
    fn kimi_survives_a_missing_or_broken_home() {
        let d = TempDir::new();
        assert!(kimi_session_dirs_in(&d.0.join("no-existe")).is_empty());

        d.write("wd_x_1/ses-x/state.json", "no soy json");
        let dir = kimi_session_dir_in(&d.0, None, None).unwrap();
        assert_eq!(kimi_title(&dir, "sin título").title, "sin título");
    }

    // ── Gemini CLI ───────────────────────────────────────────────────

    /// Cabecera real de un archivo de chat de Gemini + una línea de mensaje.
    fn gemini_chat(session_id: &str, kind: &str, body: &str) -> String {
        format!(
            "{}\n{}",
            serde_json::json!({
                "sessionId": session_id, "projectHash": "h",
                "startTime": "2026-08-03T10:00:00Z", "lastUpdated": "2026-08-03T10:05:00Z",
                "kind": kind
            }),
            body
        )
    }

    /// El slug de la carpeta es asignado por el registro de Gemini y NO se puede derivar del
    /// cwd (`mi-proyecto`, `mi-proyecto-1` si choca), así que hay que consultarlo.
    #[test]
    fn gemini_resolves_the_project_dir_through_the_registry() {
        let d = TempDir::new();
        d.write("projects.json", r#"{"projects":{"/home/u/proj":"proj-1"}}"#);
        let chat = d.write("tmp/proj-1/chats/session-a.jsonl", &gemini_chat("ses-a", "main", ""));

        assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(chat));
    }

    /// Si el registro no ayuda (versión vieja, archivo corrupto), quedan los marcadores
    /// `.project_root` que Gemini escribe en cada carpeta de proyecto.
    #[test]
    fn gemini_falls_back_to_the_project_root_markers() {
        let d = TempDir::new();
        d.write("tmp/proj-1/.project_root", "/home/u/proj\n");
        let chat = d.write("tmp/proj-1/chats/session-a.jsonl", &gemini_chat("ses-a", "main", ""));

        assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(chat));
    }

    /// Regresión: el filtro anterior era `contenido.contains(cwd)` sobre TODO `~/.gemini/tmp`,
    /// y `/home/u/proj` está contenido en `/home/u/proj2`.
    #[test]
    fn gemini_does_not_pick_up_another_projects_session() {
        let d = TempDir::new();
        d.write("projects.json", r#"{"projects":{"/home/u/proj":"proj","/home/u/proj2":"proj2"}}"#);
        d.write("tmp/proj2/chats/session-otro.jsonl", &gemini_chat("ses-otro", "main", ""));
        let mine = d.write("tmp/proj/chats/session-mio.jsonl", &gemini_chat("ses-mio", "main", ""));

        assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(mine));
    }

    /// Los sub-agentes escriben su propio archivo en la misma carpeta `chats/`. Si la tab
    /// adopta el id de un sub-agente, `--resume <id>` no devuelve a la conversación real.
    #[test]
    fn gemini_ignores_subagent_sessions() {
        let d = TempDir::new();
        d.write("tmp/proj/.project_root", "/home/u/proj");
        let main = d.write("tmp/proj/chats/session-main.jsonl", &gemini_chat("ses-main", "main", ""));
        // Se escribe después para que sea el más nuevo por mtime: sin el filtro, ganaría.
        d.write("tmp/proj/chats/session-sub.jsonl", &gemini_chat("ses-sub", "subagent", ""));

        assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(main));
    }

    #[test]
    fn gemini_reads_the_session_id_from_the_header() {
        let d = TempDir::new();
        let chat = d.write("c.jsonl", &gemini_chat("ses-42", "main", ""));
        assert_eq!(gemini_meta(&chat).unwrap().session_id.as_deref(), Some("ses-42"));
    }

    /// El contenido de Gemini es un `Part[]` sin campo `type` — antes solo se leía el caso
    /// `content` string pelado, así que el título nunca salía del primer mensaje.
    #[test]
    fn gemini_title_reads_part_list_content() {
        let d = TempDir::new();
        let body = r#"{"id":"m1","type":"user","content":[{"text":"arreglá el login"}]}"#;
        let chat = d.write("c.jsonl", &gemini_chat("ses-a", "main", body));

        let result = gemini_title(&chat, "sin título");
        assert_eq!(result.title, "arreglá el login");
        assert_eq!(result.source, "first_message");
    }

    #[test]
    fn gemini_title_prefers_the_summary() {
        let d = TempDir::new();
        let body = concat!(
            r#"{"id":"m1","type":"user","content":[{"text":"arreglá el login"}]}"#, "\n",
            r#"{"$set":{"summary":"Arreglo del login"}}"#,
        );
        let chat = d.write("c.jsonl", &gemini_chat("ses-a", "main", body));

        let result = gemini_title(&chat, "sin título");
        assert_eq!(result.title, "Arreglo del login");
        assert_eq!(result.source, "summary");
    }
}
