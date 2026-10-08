//! El stream de Claude Code traducido a lo que dibuja el chat de una tab en modo HTML.
//!
//! Sirve para las dos fuentes, que tienen la misma forma: una línea de
//! `--output-format stream-json` mientras el turno corre, y una entrada del `.jsonl` de la
//! sesión al cargar el historial. Lo de `runs/agents.rs` no alcanza: aquel resume cada
//! mensaje en una línea de 96 letras para la tarjeta de la flota; acá hace falta TODO —el
//! texto entero, el input de cada herramienta y su resultado— para dibujar la conversación.
//!
//! Tolerante como aquel: una línea que no se entiende no se muestra, nunca rompe el chat.

use serde::Serialize;
use serde_json::Value;

use crate::runs::activity::tool_label;

/// Tope del resultado de una herramienta. Un `Read` de un archivo grande o un `cargo build`
/// verborrágico pueden traer cientos de KB, y cada evento viaja entero al webview.
pub const MAX_RESULT_CHARS: usize = 30_000;

/// Lo que el chat sabe pintar.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    /// El arranque del proceso: con qué modelo y qué comandos tiene.
    Init {
        session_id: Option<String>,
        model: Option<String>,
        permission_mode: Option<String>,
        /// Comandos de `/`: los built-in, las skills y los de `.claude/commands`.
        slash_commands: Vec<String>,
        /// Los que solo funcionan en la TUI.
        terminal_commands: Vec<String>,
    },
    /// "Pidiendo", "compactando"… `None` = volvió a lo normal.
    Status { status: Option<String> },
    /// Un pedazo de texto mientras se escribe. El bloque entero llega después en `Text`.
    TextDelta { text: String, parent: Option<String> },
    ThinkingDelta { text: String, parent: Option<String> },
    /// Una herramienta que se empezó a escribir; el input llega con `ToolUse`.
    ToolStart { id: String, name: String, parent: Option<String> },
    Text { text: String, parent: Option<String> },
    Thinking { text: String, parent: Option<String> },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        /// `Bash(cargo test)`, `Edit(src/main.rs)`: el encabezado de la tarjeta.
        label: String,
        /// La herramienta `Task` que lanzó al subagente que la usa. `None` = la conversación.
        parent: Option<String>,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        /// Imágenes que devolvió (una captura, un `Read` de un png): solo cuántas.
        images: usize,
        truncated: bool,
        parent: Option<String>,
    },
    /// Lo que escribió la persona. En el stream no vuelve (el chat ya lo dibujó al
    /// mandarlo); sale del historial.
    User { text: String, images: usize },
    /// Un comando de `/` que se corrió, y su salida.
    Command { name: String, args: String },
    CommandOutput { text: String },
    /// La conversación se compactó. El resumen llega aparte, en `Summary`.
    Compacted,
    Summary { text: String },
    /// El turno terminó.
    Result {
        ok: bool,
        error: Option<String>,
        cost_usd: Option<f64>,
        tokens_in: Option<i64>,
        tokens_out: Option<i64>,
        duration_ms: Option<i64>,
    },
    /// La API falló y la CLI va a reintentar.
    Retry { attempt: Option<i64>, max_retries: Option<i64>, error: Option<String> },
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Traduce una línea (del stream o del `.jsonl`).
pub fn parse_line(line: &str) -> Vec<ChatEvent> {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => parse_value(&v),
        Err(_) => Vec::new(),
    }
}

pub fn parse_value(v: &Value) -> Vec<ChatEvent> {
    // El subagente de una `Task` escribe en el mismo stream, marcado con quién lo lanzó.
    let parent = str_of(v, "parent_tool_use_id");
    match v.get("type").and_then(Value::as_str) {
        Some("system") => system(v),
        Some("stream_event") => v.get("event").map(|e| stream_event(e, parent)).unwrap_or_default(),
        Some("assistant") => assistant(v, parent),
        Some("user") => user(v, parent),
        Some("result") => vec![result(v)],
        _ => Vec::new(),
    }
}

fn system(v: &Value) -> Vec<ChatEvent> {
    match v.get("subtype").and_then(Value::as_str) {
        Some("init") => vec![ChatEvent::Init {
            session_id: str_of(v, "session_id"),
            model: str_of(v, "model"),
            permission_mode: str_of(v, "permissionMode"),
            slash_commands: strings(v, "slash_commands"),
            terminal_commands: strings(v, "terminal_slash_commands"),
        }],
        Some("status") => vec![ChatEvent::Status { status: str_of(v, "status") }],
        Some("compact_boundary") => vec![ChatEvent::Compacted],
        Some("api_retry") => vec![ChatEvent::Retry {
            attempt: v.get("attempt").and_then(Value::as_i64),
            max_retries: v.get("max_retries").and_then(Value::as_i64),
            error: v.get("error").map(|e| match e.as_str() {
                Some(s) => s.to_string(),
                None => e.to_string(),
            }),
        }],
        _ => Vec::new(),
    }
}

fn stream_event(e: &Value, parent: Option<String>) -> Vec<ChatEvent> {
    match e.get("type").and_then(Value::as_str) {
        Some("content_block_start") => {
            let Some(block) = e.get("content_block") else { return Vec::new() };
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                return Vec::new();
            }
            match (str_of(block, "id"), str_of(block, "name")) {
                (Some(id), Some(name)) => vec![ChatEvent::ToolStart { id, name, parent }],
                _ => Vec::new(),
            }
        }
        Some("content_block_delta") => {
            let Some(delta) = e.get("delta") else { return Vec::new() };
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => str_of(delta, "text")
                    .map(|text| vec![ChatEvent::TextDelta { text, parent }])
                    .unwrap_or_default(),
                Some("thinking_delta") => str_of(delta, "thinking")
                    .map(|text| vec![ChatEvent::ThinkingDelta { text, parent }])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

fn assistant(v: &Value, parent: Option<String>) -> Vec<ChatEvent> {
    let Some(content) = v.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str) {
            Some("text") => str_of(block, "text")
                .filter(|t| !t.trim().is_empty())
                .map(|text| ChatEvent::Text { text, parent: parent.clone() }),
            Some("thinking") => str_of(block, "thinking")
                .filter(|t| !t.trim().is_empty())
                .map(|text| ChatEvent::Thinking { text, parent: parent.clone() }),
            Some("tool_use") => {
                let id = str_of(block, "id")?;
                let name = str_of(block, "name")?;
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                Some(ChatEvent::ToolUse { label: tool_label(&name, &input), id, name, input, parent: parent.clone() })
            }
            _ => None,
        })
        .collect()
}

fn user(v: &Value, parent: Option<String>) -> Vec<ChatEvent> {
    // Los "meta" son contexto que la CLI le inyecta al modelo (la advertencia que antecede
    // a un comando local, los recordatorios), no algo que la persona escribió.
    if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    let Some(content) = v.pointer("/message/content") else { return Vec::new() };

    // El resumen de una compactación: en el `.jsonl` viene marcado `isCompactSummary`, en el
    // stream `isSynthetic`.
    if flag("isCompactSummary") || (flag("isSynthetic") && !flag("isReplay")) {
        return text_of(content).map(|text| vec![ChatEvent::Summary { text }]).unwrap_or_default();
    }

    match content {
        Value::String(s) => user_text(s, 0),
        Value::Array(blocks) => {
            let mut out = Vec::new();
            let mut text = String::new();
            let mut images = 0;
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_result") => {
                        let Some(id) = str_of(block, "tool_use_id") else { continue };
                        let (content, images, truncated) = result_content(block.get("content"));
                        out.push(ChatEvent::ToolResult {
                            tool_use_id: id,
                            content,
                            is_error: block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                            images,
                            truncated,
                            parent: parent.clone(),
                        });
                    }
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some("image") => images += 1,
                    _ => {}
                }
            }
            // El prompt de un subagente es parte de la herramienta `Task`, no algo que la
            // persona escribió.
            if parent.is_none() && (!text.is_empty() || images > 0) {
                out.extend(user_text(&text, images));
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Un mensaje de texto de la persona, o un comando de `/` y su salida, que la CLI guarda
/// envueltos en etiquetas.
fn user_text(text: &str, images: usize) -> Vec<ChatEvent> {
    if let Some(name) = tag(text, "command-name") {
        let args = tag(text, "command-args").unwrap_or_default();
        return vec![ChatEvent::Command { name: name.trim_start_matches('/').to_string(), args }];
    }
    if let Some(out) = tag(text, "local-command-stdout").or_else(|| tag(text, "local-command-stderr")) {
        return vec![ChatEvent::CommandOutput { text: out.trim().to_string() }];
    }
    // Lo que la CLI agrega sola al historial (el aviso de "interrumpido", un recordatorio).
    if text.starts_with("<local-command-caveat>") || text.starts_with("<system-reminder>") {
        return Vec::new();
    }
    if text.trim().is_empty() && images == 0 {
        return Vec::new();
    }
    vec![ChatEvent::User { text: text.to_string(), images }]
}

/// El contenido de `<name>…</name>`, si el texto lo tiene.
fn tag(text: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

/// El texto del resultado de una herramienta, cuántas imágenes traía y si se recortó.
fn result_content(content: Option<&Value>) -> (String, usize, bool) {
    let (text, images) = match content {
        Some(Value::String(s)) => (s.clone(), 0),
        Some(Value::Array(blocks)) => {
            let images = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("image")).count();
            (text_of(&Value::Array(blocks.clone())).unwrap_or_default(), images)
        }
        _ => (String::new(), 0),
    };
    let (text, truncated) = clip(&text, MAX_RESULT_CHARS);
    (text, images, truncated)
}

/// Las primeras `max` letras, sin partir un carácter.
fn clip(s: &str, max: usize) -> (String, bool) {
    match s.char_indices().nth(max) {
        Some((at, _)) => (s[..at].to_string(), true),
        None => (s.to_string(), false),
    }
}

fn result(v: &Value) -> ChatEvent {
    let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    // Un cierre con error suele venir sin texto: el motivo está en el `subtype`
    // (`error_max_turns`, `error_during_execution`).
    let error = is_error.then(|| str_of(v, "result").or_else(|| str_of(v, "subtype"))).flatten();
    let get = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(Value::as_i64);
    let input = [get("input_tokens"), get("cache_creation_input_tokens"), get("cache_read_input_tokens")];
    ChatEvent::Result {
        ok: !is_error,
        error,
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        tokens_in: input.iter().any(Option::is_some).then(|| input.iter().flatten().sum()),
        tokens_out: get("output_tokens"),
        duration_ms: v.get("duration_ms").and_then(Value::as_i64),
    }
}

/// El historial entero de un `.jsonl` de sesión.
///
/// Sin los deltas (el archivo no los tiene) ni los `Result` (tampoco). Las líneas de un
/// subagente (`isSidechain`) no se guardan acá sino en su propio archivo, así que tampoco
/// aparecen.
pub fn transcript(content: &str) -> Vec<ChatEvent> {
    content
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("isSidechain").and_then(Value::as_bool) != Some(true))
        .flat_map(|v| parse_value(&v))
        .collect()
}

/// Con qué modelo y esfuerzo está corriendo una sesión, según su `.jsonl`.
#[derive(serde::Serialize, Default, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    /// El nombre completo (`claude-opus-5-5`) o el alias que se eligió con `/model`.
    pub model: Option<String>,
    /// `low` … `max`.
    pub effort: Option<String>,
}

/// Lo último que rige en la sesión: el modelo y el esfuerzo de la última respuesta, o un
/// `/model` / `/effort` posterior (la TUI los aplica al resto de la conversación aunque
/// todavía no haya respondido nada con ellos).
///
/// Hace falta porque `claude -p --resume` no hereda el esfuerzo (vuelve al de fábrica en
/// cada turno), y porque al pasar de la consola al chat la persona espera seguir con lo que
/// tenía puesto en la TUI, no con lo último que eligió en el chat.
pub fn session_settings(content: &str) -> SessionSettings {
    let mut out = SessionSettings::default();
    // Un `/model` sin argumentos abre el selector de la TUI: lo elegido aparece recién en
    // la salida del comando, que es la entrada siguiente.
    let mut waiting: Option<&'static str> = None;
    for v in content.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                // Las respuestas que arma la CLI sola (la salida de un comando) dicen
                // `<synthetic>`: no corrieron con ningún modelo.
                if let Some(model) = v.pointer("/message/model").and_then(Value::as_str).filter(|m| !m.starts_with('<')) {
                    out.model = Some(model.to_string());
                }
                if let Some(effort) = v.get("effort").and_then(Value::as_str) {
                    out.effort = Some(effort.to_string());
                }
            }
            Some("user") => {
                let Some(text) = v.pointer("/message/content").and_then(text_of) else { continue };
                if let Some(name) = tag(&text, "command-name") {
                    let args = tag(&text, "command-args").unwrap_or_default();
                    waiting = None;
                    match name.trim_start_matches('/') {
                        "model" if args.is_empty() => waiting = Some("model"),
                        "model" => out.model = model_from(&args),
                        "effort" if args.is_empty() => waiting = Some("effort"),
                        "effort" => out.effort = effort_from(&args).or(out.effort),
                        _ => {}
                    }
                } else if let Some(stdout) = tag(&text, "local-command-stdout") {
                    match waiting.take() {
                        // "Set model to Opus 5.5 (default)", "Set model to `Haiku 5.5` …"
                        Some("model") => {
                            if let Some(rest) = stdout.split("Set model to ").nth(1) {
                                out.model = model_from(rest.trim_start_matches('`')).or(out.model);
                            }
                        }
                        // "Set effort level to low (this session only): …"
                        Some("effort") => {
                            if let Some(rest) = stdout.split("Set effort level to ").nth(1) {
                                out.effort = effort_from(rest).or(out.effort);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Lo que va a `--model` a partir de lo que se escribió o se mostró: un nombre completo
/// queda igual, y un nombre para mostrar (`Opus 5.5`) se vuelve su alias (`opus`).
fn model_from(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?.trim_matches(|c: char| c == '`' || c == '"');
    if first.is_empty() || first.eq_ignore_ascii_case("default") {
        return None;
    }
    Some(if first.starts_with("claude-") { first.to_string() } else { first.to_lowercase() })
}

fn effort_from(text: &str) -> Option<String> {
    let word = text.split(|c: char| !c.is_ascii_alphanumeric()).find(|w| !w.is_empty())?.to_lowercase();
    is_effort(&word).then_some(word)
}

/// Los niveles que acepta `claude --effort`.
fn is_effort(level: &str) -> bool {
    matches!(level, "low" | "medium" | "high" | "xhigh" | "max")
}
