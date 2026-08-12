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

pub(super) fn fallback_result(fallback: &str) -> SessionTitleResult {
    SessionTitleResult { title: fallback.to_string(), source: "fallback".to_string() }
}

pub(super) fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max).collect::<String>().trim())
    }
}

pub(super) fn mtime_secs(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

pub(super) fn collect_files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
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

pub(super) fn newest_matching(
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
pub(super) fn first_line_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// El más nuevo (por mtime) de los candidatos que pasen `keep`, respetando el piso `after`.
///
/// Variante de `newest_matching` para los agentes cuyo filtro NO es "el cwd aparece en
/// algún lado del archivo" sino una condición que se puede decidir leyendo solo metadata.
pub(super) fn newest_where(
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

pub(super) fn find_string_field(path: &Path, candidates: &[&str]) -> Option<String> {
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
pub(super) fn extract_text_block(content: &Value) -> Option<String> {
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

/// Nombre de carpeta que Claude Code le da a un proyecto.
///
/// **Reemplaza TODO lo que no sea alfanumérico por `-`, no solo las barras.** Derivado
/// contra las carpetas reales de una instalación con proyectos de nombres variados: la
/// regla acierta 8 de 8, mientras que reemplazar solo `/` fallaba en los 3 proyectos cuya
/// ruta tiene un espacio.
///
/// Ese era un bug silencioso y caro: para cualquier proyecto en una ruta con espacios (o
/// puntos, o cualquier otro carácter especial) se buscaba en una carpeta que no existe, así
/// que la sesión nunca se descubría. Esas tabs quedaban sin id de sesión —sin título real,
/// sin reanudar al reabrirlas y sin poder actualizar su entrada del historial— y desde
/// afuera se veía como "la app no guarda las sesiones".
pub(super) fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// `profile` es el directorio de la cuenta con la que corre la tab (`CLAUDE_CONFIG_DIR`).
/// Con una cuenta alternativa, TODO lo de Claude Code vive ahí adentro — incluidos los
/// transcripts — así que buscar en `~/.claude` daría siempre "sin sesión": ni título ni
/// resume. `None` = la cuenta del sistema.
pub(super) fn claude_project_dir(cwd: &str, profile: Option<&Path>) -> PathBuf {
    let root = match profile {
        Some(dir) => dir.to_path_buf(),
        None => dirs::home_dir().unwrap_or_default().join(".claude"),
    };
    let projects = root.join("projects");
    let dir = projects.join(claude_project_slug(cwd));
    if dir.exists() {
        return dir;
    }
    // Respaldo para instalaciones viejas de Claude Code, que sí usaban solo las barras.
    // Solo se toma si existe de verdad, así que no puede tapar a la regla buena.
    let legacy = projects.join(cwd.replace('/', "-"));
    if legacy.exists() {
        return legacy;
    }
    dir
}

pub(super) fn claude_session_file(
    cwd: &str,
    session_id: Option<&str>,
    after: Option<i64>,
    profile: Option<&Path>,
) -> Option<PathBuf> {
    let dir = claude_project_dir(cwd, profile);
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

pub(super) fn claude_title(path: &Path, fallback: &str) -> SessionTitleResult {
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

pub(super) fn gemini_home() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".gemini")
}

/// Carpeta que Gemini le asignó a este cwd, o `None` si nunca abrió una sesión acá.
pub(super) fn gemini_project_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
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
pub(super) struct GeminiMeta {
    pub(super) session_id: Option<String>,
    pub(super) kind: Option<String>,
}

pub(super) fn gemini_meta(path: &Path) -> Option<GeminiMeta> {
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
pub(super) fn gemini_is_main_session(path: &Path) -> bool {
    match gemini_meta(path) {
        Some(m) => m.kind.as_deref() != Some("subagent"),
        None => false,
    }
}

pub(super) fn gemini_chat_files(home: &Path, cwd: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(dir) = gemini_project_dir(home, cwd) {
        collect_files(&dir.join("chats"), "jsonl", &mut files);
    }
    files
}

pub(super) fn gemini_session_file(cwd: &str, after: Option<i64>) -> Option<PathBuf> {
    gemini_session_file_in(&gemini_home(), cwd, after)
}

pub(super) fn gemini_session_file_in(home: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
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

pub(super) fn gemini_session_file_by_id(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    gemini_chat_files(home, cwd)
        .into_iter()
        .find(|p| gemini_meta(p).and_then(|m| m.session_id).as_deref() == Some(session_id))
}

pub(super) fn gemini_title(path: &Path, fallback: &str) -> SessionTitleResult {
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

pub(super) fn codex_root(profile: Option<&Path>) -> PathBuf {
    if let Some(dir) = profile {
        return dir.join("sessions");
    }
    // Codex respeta CODEX_HOME para reubicar toda su configuración y su historial; si no
    // está definida cae en ~/.codex.
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
    home.join("sessions")
}

/// Cabecera `session_meta` de un rollout: lo que hace falta para identificar la sesión sin
/// leer la conversación. `None` si el archivo no arranca con una cabecera reconocible.
pub(super) struct CodexMeta {
    pub(super) id: Option<String>,
    pub(super) cwd: PathBuf,
}

pub(super) fn codex_meta(path: &Path) -> Option<CodexMeta> {
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

pub(super) fn codex_rollouts_in(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files(root, "jsonl", &mut files);
    files
}

pub(super) fn codex_rollouts(profile: Option<&Path>) -> Vec<PathBuf> {
    codex_rollouts_in(&codex_root(profile))
}

/// Rollout de la sesión con ESTE id exacto. Se prefiere a "el más nuevo del cwd" cuando el
/// id se conoce: con dos tabs de Codex abiertas en la misma carpeta, "el más nuevo" es el de
/// la otra tab y los títulos quedarían cruzados.
pub(super) fn codex_session_file_by_id(session_id: &str, profile: Option<&Path>) -> Option<PathBuf> {
    codex_rollouts(profile)
        .into_iter()
        .find(|p| codex_meta(p).and_then(|m| m.id).as_deref() == Some(session_id))
}

pub(super) fn codex_session_file(cwd: &str, after: Option<i64>, profile: Option<&Path>) -> Option<PathBuf> {
    codex_session_file_in(&codex_root(profile), cwd, after)
}

pub(super) fn codex_session_file_in(root: &Path, cwd: &str, after: Option<i64>) -> Option<PathBuf> {
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
pub(super) fn codex_is_synthetic(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("## My environment")
}

pub(super) fn codex_title(path: &Path, fallback: &str) -> SessionTitleResult {
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
pub(super) struct OpencodeSession {
    pub(super) id: String,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) directory: String,
    #[serde(default)]
    pub(super) created: i64,
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
/// Cuánto se espera a `opencode` antes de darlo por colgado. Generoso frente a lo que
/// tarda de verdad (~1s medido) y muy por debajo de lo que un usuario tolera esperando a
/// que cierre una ventana.
const OPENCODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) fn opencode_sessions(cwd: &str, profile: Option<&Path>) -> Vec<OpencodeSession> {
    let mut command = std::process::Command::new("opencode");
    command
        .args(["session", "list", "--format", "json", "-n", "50"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null());
    // Misma variable con la que se lanzó la tab (ver `accounts`): sin esto, `session list`
    // listaría las sesiones de la cuenta del sistema y el título saldría cruzado.
    if let Some(dir) = profile {
        command.env("XDG_DATA_HOME", dir);
    }
    // Con plazo: esta función corre en el camino de cerrar una tab, y un `opencode`
    // colgado no puede dejar a la app esperándolo para siempre.
    let output = match crate::util::output_with_timeout(&mut command, OPENCODE_TIMEOUT) {
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
pub(super) fn opencode_session(cwd: &str, after: Option<i64>, profile: Option<&Path>) -> Option<OpencodeSession> {
    let sessions = opencode_sessions(cwd, profile);
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
pub(super) fn opencode_is_placeholder_title(title: &str) -> bool {
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

pub(super) fn kimi_root() -> PathBuf {
    let home = std::env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".kimi-code"));
    home.join("sessions")
}

/// Carpetas de sesión: los nietos de `sessions/` que tengan un `state.json`.
/// Se camina en dos niveles exactos en vez de recursivamente porque adentro de cada sesión
/// hay muchos más `.json` (`upcoming-goals.json`, `agents/*/plans/*`) que no son sesiones.
pub(super) fn kimi_session_dirs() -> Vec<PathBuf> {
    kimi_session_dirs_in(&kimi_root())
}

pub(super) fn kimi_session_dirs_in(root: &Path) -> Vec<PathBuf> {
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

pub(super) fn kimi_state(dir: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(dir.join("state.json")).ok()?).ok()
}

/// El id de la sesión es el nombre de su carpeta — que es lo que espera `kimi --session`.
pub(super) fn kimi_session_id(dir: &Path) -> Option<String> {
    dir.file_name().map(|s| s.to_string_lossy().to_string())
}

/// Directorio de trabajo declarado en `state.json`, si lo declara.
///
/// La doc lista los campos de `state.json` como "title, lastPrompt, timestamps, forkedFrom"
/// sin enumerarlos todos, así que no está garantizado que el cwd esté ahí. Devolver `None`
/// cuando no aparece es deliberado: el llamador entonces NO filtra por cwd en vez de
/// filtrar con un criterio inventado y quedarse sin resultados.
pub(super) fn kimi_declared_cwd(state: &Value) -> Option<PathBuf> {
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
pub(super) fn kimi_session_dir(cwd: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
    kimi_session_dir_in(&kimi_root(), cwd, after)
}

pub(super) fn kimi_session_dir_in(root: &Path, cwd: Option<&str>, after: Option<i64>) -> Option<PathBuf> {
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

pub(super) fn kimi_session_dir_by_id(session_id: &str) -> Option<PathBuf> {
    kimi_session_dirs().into_iter().find(|d| kimi_session_id(d).as_deref() == Some(session_id))
}

/// `agents/main/wire.jsonl` es el stream del agente principal — la conversación. Los
/// `agents/agent-N/` son sub-agentes y no van al export.
pub(super) fn kimi_wire_file(dir: &Path) -> Option<PathBuf> {
    let wire = dir.join("agents/main/wire.jsonl");
    wire.is_file().then_some(wire)
}

/// Título de una sesión de Kimi. A diferencia del resto de los agentes no hay que deducirlo
/// del primer mensaje: Kimi lo guarda en `state.json` (y el usuario puede fijarlo a mano con
/// `/title`). `lastPrompt` es el respaldo cuando todavía no le puso título.
pub(super) fn kimi_title(dir: &Path, fallback: &str) -> SessionTitleResult {
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
pub(super) fn custom_session_file(agent: &crate::agents::CustomAgent, after: Option<i64>) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    newest_matching(&files, after, None)
}

/// Archivo de la sesión con ESTE id exacto, ya sea porque el id es el nombre del archivo
/// o porque aparece adentro. Recorre la carpeta declarada; devuelve `None` si no aparece.
pub(super) fn custom_session_file_by_id(
    agent: &crate::agents::CustomAgent,
    session_id: &str,
) -> Option<PathBuf> {
    let root = agent.resolved_sessions_dir()?;
    let mut files = Vec::new();
    collect_files(&root, "jsonl", &mut files);
    collect_files(&root, "json", &mut files);
    files.into_iter().find(|p| custom_session_id(agent, p).as_deref() == Some(session_id))
}

pub(super) fn custom_session_id(agent: &crate::agents::CustomAgent, path: &Path) -> Option<String> {
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
pub(super) fn custom_title(path: &Path, fallback: &str) -> SessionTitleResult {
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
    // Directorio de la cuenta con la que corrió la sesión; `None` = la del sistema.
    profile: Option<&Path>,
    db: &tauri::State<crate::database::DbConnection>,
) -> Option<PathBuf> {
    match agent_id {
        "claude-code" => claude_session_file(cwd, session_id, None, profile),
        "gemini-cli" => match session_id {
            Some(id) => gemini_session_file_by_id(&gemini_home(), cwd, id),
            None => gemini_session_file(cwd, None),
        },
        "codex" => codex_session_file(cwd, None, profile),
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
///
/// **Corre en `spawn_blocking` y no directo.** Un `#[tauri::command]` declarado como `fn`
/// (sin `async`) lo ejecuta Tauri **en el hilo principal**, que es el del bucle de eventos
/// de la ventana. Y este trabajo no es instantáneo: para OpenCode levanta un proceso
/// (`opencode session list`, ~0.65s medidos) y para el resto lee metadata de disco. Como
/// el frontend lo llama cada pocos segundos por cada tab, el hilo principal quedaba
/// congelado en ráfagas justo mientras la terminal intentaba pintar sus primeros bytes —
/// se veía como una terminal negra que nunca arranca. Es el mismo problema que ya tenía
/// `agents::detect_agents`, resuelto igual.
#[tauri::command]
pub async fn discover_session_id(
    agent_id: String,
    cwd: String,
    started_after: i64,
    // Cuenta con la que corre la tab, si no es la del sistema. Se recibe el id y no la
    // ruta: la cuenta puede haberse mudado desde que la tab se guardó.
    account_id: Option<String>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<Option<String>, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id));
        let custom = db.lock().ok().and_then(|conn| crate::agents::find(&conn, &agent_id));
        discover_session_id_sync(
            &agent_id,
            &cwd,
            started_after,
            profile.as_deref().map(Path::new),
            custom.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// `custom` es la TUI personalizada ya resuelta, o `None` para las de fábrica.
///
/// Se recibe resuelta en vez de un `DbConnection` porque hay un llamador que YA tiene la
/// conexión tomada (`archive_tab_row`): volver a pedir el lock desde adentro contra un
/// `Mutex` no reentrante sería un deadlock, no un error.
pub(crate) fn discover_session_id_sync(
    agent_id: &str,
    cwd: &str,
    started_after: i64,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
) -> Option<String> {
    let cwd = cwd.to_string();
    match agent_id {
        "claude-code" => {
            let path = claude_session_file(&cwd, None, Some(started_after), profile)?;
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
            let path = codex_session_file(&cwd, Some(started_after), profile)?;
            // La cabecera `session_meta` trae el id; `find_string_field` queda como respaldo
            // por si una versión emite el rollout sin cabecera reconocible.
            codex_meta(&path)
                .and_then(|m| m.id)
                .or_else(|| find_string_field(&path, &["session_id", "id"]))
        }
        "opencode" => opencode_session(&cwd, Some(started_after), profile).map(|s| s.id),
        "kimi-code" => {
            let dir = kimi_session_dir(Some(&cwd), Some(started_after))?;
            kimi_session_id(&dir)
        }
        // TUI custom: solo si el usuario declaró dónde guarda sus sesiones.
        _ => {
            let agent = custom?;
            let path = custom_session_file(agent, Some(started_after))?;
            custom_session_id(agent, &path)
        }
    }
}

/// Genera un título legible para la tab a partir de la sesión real del agente.
/// Si el agente no es soportado o no se encuentra la sesión, devuelve `fallback`.
///
/// En `spawn_blocking` por el mismo motivo que `discover_session_id`: lee sesiones de
/// disco y, para OpenCode, levanta un proceso.
#[tauri::command]
pub async fn get_session_title(
    agent_id: String,
    cwd: String,
    session_id: Option<String>,
    fallback: String,
    account_id: Option<String>,
    db: tauri::State<'_, crate::database::DbConnection>,
) -> Result<SessionTitleResult, String> {
    let db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let profile = account_id.and_then(|id| crate::accounts::dir_for(&db, &id));
        let custom = db.lock().ok().and_then(|conn| crate::agents::find(&conn, &agent_id));
        get_session_title_sync(
            &agent_id,
            &cwd,
            session_id,
            fallback,
            profile.as_deref().map(Path::new),
            custom.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// `custom` viene resuelta por el llamador, por el mismo motivo que en
/// `discover_session_id_sync`: hay quien llama con la conexión ya tomada.
pub(crate) fn get_session_title_sync(
    agent_id: &str,
    cwd: &str,
    session_id: Option<String>,
    fallback: String,
    profile: Option<&Path>,
    custom: Option<&crate::agents::CustomAgent>,
) -> SessionTitleResult {
    let cwd = cwd.to_string();
    match agent_id {
        "claude-code" => match claude_session_file(&cwd, session_id.as_deref(), None, profile) {
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
                Some(id) => codex_session_file_by_id(id, profile),
                None => codex_session_file(&cwd, None, profile),
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
                Some(id) => opencode_sessions(&cwd, profile).into_iter().find(|s| s.id == id),
                None => opencode_session(&cwd, None, profile),
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
        _ => {
            let Some(id) = session_id else { return fallback_result(&fallback) };
            let Some(agent) = custom else { return fallback_result(&fallback) };
            match custom_session_file_by_id(agent, &id) {
                Some(path) => custom_title(&path, &fallback),
                None => fallback_result(&fallback),
            }
        }
    }
}
