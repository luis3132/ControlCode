//! Las TUIs que no son Claude Code, corriendo sin terminal.
//!
//! Cada una tiene su modo headless y su dialecto de eventos, pero ninguna tiene lo que
//! Claude Code le da a la flota además del stream: no se le puede imponer el id de sesión
//! (salvo Gemini), no aceptan un system prompt aparte, no hacen cumplir un JSON Schema
//! (salvo Codex) y ninguna tiene cómo mandarle una pregunta de permiso a la consola. Lo que
//! falta se resuelve igual para todas:
//!
//! - **System prompt y schema** van adelante del pedido, en el mismo mensaje.
//! - **El id de sesión** lo dice la TUI en su primer evento, y el supervisor lo guarda en la
//!   fila (ver `supervisor.rs`): es el que sirve para reabrir la tarea como tab.
//! - **Permisos:** sin consola que conteste, lo que preguntaría se rechaza, igual que Claude
//!   Code sin broker. Las ediciones pasan; los comandos, según lo que cada TUI permite
//!   (ver cada `launch`).
//! - **El cierre:** varias no emiten un "terminé" con el resultado, así que se junta en el
//!   camino (el último mensaje, los tokens) y se arma al salir el proceso.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::activity::{text_line, tool_label};
use super::agents::{HeadlessAgent, Launch, LaunchCtx};
use super::types::{AgentEvent, TaskOutcome};

/// Lo que se va juntando de una corrida para armar el resultado al final.
#[derive(Default)]
struct Tally {
    started: bool,
    /// El último mensaje del agente: es su respuesta.
    last_text: Option<String>,
    /// Gemini manda el texto de a pedazos: se junta hasta que llega otra cosa.
    pending: String,
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
    cost: Option<f64>,
    error: Option<String>,
}

impl Tally {
    fn add_tokens(&mut self, input: Option<i64>, output: Option<i64>) {
        if let Some(i) = input {
            self.tokens_in = Some(self.tokens_in.unwrap_or(0) + i);
        }
        if let Some(o) = output {
            self.tokens_out = Some(self.tokens_out.unwrap_or(0) + o);
        }
    }

    /// El `Started` del primer evento, una sola vez.
    fn start(&mut self, session_id: Option<String>) -> Option<AgentEvent> {
        if self.started {
            return None;
        }
        self.started = true;
        Some(AgentEvent::Started { session_id })
    }

    fn outcome(&self, code: i32) -> TaskOutcome {
        let ok = code == 0 && self.error.is_none();
        TaskOutcome {
            ok,
            result: if ok { self.last_text.clone() } else { None },
            error: if ok {
                None
            } else {
                Some(self.error.clone().unwrap_or_else(|| format!("el agente terminó con código {code}")))
            },
            cost_usd: self.cost,
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
        }
    }
}

/// El pedido con lo que en Claude Code va por flags aparte: las reglas del entorno arriba,
/// y el formato del resultado abajo.
fn full_prompt(prompt: &str, ctx: &LaunchCtx, schema_enforced: bool) -> String {
    let mut out = String::new();
    if let Some(system) = &ctx.system_prompt {
        out.push_str(system.trim());
        out.push_str("\n\n---\n\n");
    }
    out.push_str(prompt);
    if let (Some(schema), false) = (&ctx.json_schema, schema_enforced) {
        out.push_str(
            "\n\n---\n\nYour final message must be ONLY a JSON object that validates against this \
             JSON Schema: no prose, no code fences.\n\n",
        );
        out.push_str(schema);
    }
    out
}

/// Cada TUI nombra distinto las mismas herramientas (`write`, `write_file`, `WriteFile`) y
/// sus argumentos (`filePath`, `path`, `absolute_path`). Se llevan a los de Claude Code, que
/// es lo que `tool_label` sabe mostrar: la tarjeta dice `Write(src/app.ts)` venga de quien
/// venga.
pub(crate) fn normalize_tool(name: &str, input: &Value) -> (String, Value) {
    let lower = name.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "read" | "read_file" | "readfile" | "read_many_files" | "view" => "Read",
        "write" | "write_file" | "writefile" | "create" => "Write",
        "edit" | "replace" | "strreplacefile" | "str_replace" | "patch" | "apply_patch" | "multiedit" => "Edit",
        "bash" | "shell" | "run_shell_command" | "exec_command" | "local_shell" => "Bash",
        "grep" | "search_file_content" | "grepfiles" => "Grep",
        "glob" | "list" | "list_directory" | "ls" => "Glob",
        "webfetch" | "web_fetch" | "fetch" => "WebFetch",
        _ => name,
    };
    let pick = |keys: &[&str]| keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(str::to_string);
    let mut out = serde_json::Map::new();
    if let Some(p) = pick(&["file_path", "filePath", "path", "absolute_path", "file"]) {
        out.insert("file_path".into(), json!(p));
    }
    if let Some(c) = pick(&["command", "cmd"]) {
        out.insert("command".into(), json!(c));
    }
    if let Some(p) = pick(&["pattern", "query", "glob"]) {
        out.insert("pattern".into(), json!(p));
    }
    if let Some(u) = pick(&["url"]) {
        out.insert("url".into(), json!(u));
    }
    (canonical.to_string(), Value::Object(out))
}

fn tool_event(name: &str, input: &Value) -> AgentEvent {
    let (name, input) = normalize_tool(name, input);
    AgentEvent::Tool { label: tool_label(&name, &input), name }
}

/// Un texto del agente: queda como su respuesta y, si tiene algo, se muestra.
fn text_event(tally: &mut Tally, text: &str) -> Option<AgentEvent> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    tally.last_text = Some(text.to_string());
    text_line(text).map(|text| AgentEvent::Text { text })
}

fn lock(tally: &Mutex<Tally>) -> std::sync::MutexGuard<'_, Tally> {
    tally.lock().unwrap_or_else(|e| e.into_inner())
}

// ── OpenCode ────────────────────────────────────────────────────

/// Verificado contra `opencode run --format json` de la 1.18.32, con una corrida real.
#[derive(Default)]
pub struct OpenCode(Mutex<Tally>);

impl OpenCode {
    /// El servidor de Control Code y los permisos, por `OPENCODE_CONFIG_CONTENT`, que se
    /// fusiona con la config del usuario (ver `ipc::mcp::opencode_config_content`).
    ///
    /// Sin terminal, lo que OpenCode preguntaría lo rechaza solo (`opencode run`:
    /// "permission requested: bash … auto-rejecting", verificado): no cuelga. Así que
    /// `"ask"` acá es "no": los comandos no corren sin alguien que los apruebe, igual que en
    /// Claude Code sin broker. Las ediciones sí, que es el trabajo de un worker en su
    /// worktree.
    fn config(ctx: &LaunchCtx) -> String {
        let prefix = crate::ipc::mcp::tool_prefix(crate::agents::McpStyle::OpencodeConfig);
        // El mismo servidor que se le pasa a Claude Code en el `--mcp-config` de la tarea.
        let server = ctx
            .mcp_config
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.pointer(&format!("/mcpServers/{}", crate::ipc::mcp::SERVER_NAME)).cloned());
        let mut config = match server {
            Some(server) => {
                let program = server.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
                let mut args: Vec<String> = server
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                args.extend(["--prefix".to_string(), prefix.clone()]);
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                serde_json::from_str(&crate::ipc::mcp::opencode_config_content(&program, &args, &prefix))
                    .unwrap_or_else(|_| json!({}))
            }
            None => json!({}),
        };
        let permission = config
            .as_object_mut()
            .map(|c| c.entry("permission").or_insert_with(|| json!({})))
            .and_then(Value::as_object_mut);
        if let Some(p) = permission {
            p.insert("edit".into(), json!("allow"));
            p.insert("bash".into(), json!("ask"));
            p.insert("external_directory".into(), json!("ask"));
            // Las de su papel en el run (las decide quien arma el lanzamiento), con el
            // nombre que les da OpenCode.
            let claude_prefix = format!("mcp__{}__", crate::ipc::mcp::SERVER_NAME);
            for tool in &ctx.allowed_tools {
                let bare = tool.strip_prefix(&claude_prefix).unwrap_or(tool);
                p.insert(format!("{prefix}{bare}"), json!("allow"));
            }
        }
        config.to_string()
    }
}

impl HeadlessAgent for OpenCode {
    fn launch(&self, prompt: &str, model: Option<&str>, _budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        let mut args: Vec<String> = vec!["run".into(), "--format".into(), "json".into()];
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        // `--` antes del pedido: uno que empiece con un guion se leería como flag.
        args.push("--".into());
        args.push(full_prompt(prompt, ctx, false));
        let mut env: HashMap<String, String> = ctx.account_env.clone();
        env.insert("OPENCODE_CONFIG_CONTENT".into(), Self::config(ctx));
        Launch {
            program: crate::agents::agent_command("opencode").unwrap_or("opencode").to_string(),
            args,
            env,
        }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let mut tally = lock(&self.0);
        let mut out: Vec<AgentEvent> = tally
            .start(v.get("sessionID").and_then(Value::as_str).map(str::to_string))
            .into_iter()
            .collect();
        let part = v.get("part").cloned().unwrap_or(Value::Null);
        match v.get("type").and_then(Value::as_str) {
            Some("text") => out.extend(text_event(&mut tally, part.get("text").and_then(Value::as_str).unwrap_or(""))),
            Some("tool_use") => {
                let name = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
                let input = part.pointer("/state/input").cloned().unwrap_or(Value::Null);
                out.push(tool_event(name, &input));
            }
            Some("step_finish") => {
                let tokens = part.get("tokens").cloned().unwrap_or(Value::Null);
                let n = |p: &str| tokens.pointer(p).and_then(Value::as_i64);
                // Como en Claude Code: el contexto que se movió, caché incluida.
                let input = [n("/input"), n("/cache/read"), n("/cache/write")];
                let input = input.iter().any(Option::is_some).then(|| input.iter().flatten().sum());
                tally.add_tokens(input, n("/output"));
                if let Some(c) = part.get("cost").and_then(Value::as_f64) {
                    tally.cost = Some(tally.cost.unwrap_or(0.0) + c);
                }
            }
            Some("error") => {
                let message = v
                    .pointer("/error/data/message")
                    .or_else(|| v.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("error de OpenCode")
                    .to_string();
                tally.error = Some(message);
            }
            _ => {}
        }
        out
    }

    fn finish(&self, emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        emitted.unwrap_or_else(|| lock(&self.0).outcome(code))
    }
}

// ── Codex ───────────────────────────────────────────────────────

/// Según la referencia de `codex exec` (non-interactive mode). No verificado contra una
/// corrida: no está instalado en la máquina donde se escribió.
#[derive(Default)]
pub struct Codex(Mutex<Tally>);

impl HeadlessAgent for Codex {
    fn launch(&self, prompt: &str, model: Option<&str>, _budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        // `workspace-write`: edita y corre comandos adentro de la carpeta de la tarea, en el
        // sandbox de Codex (sin red, sin tocar afuera). Es lo más parecido a un worker en su
        // worktree, y con `exec` no hay a quién preguntarle nada más.
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "workspace-write".into(),
        ];
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        // El único además de Claude Code que hace cumplir un schema, y lo lee de un archivo.
        let schema_file = ctx.json_schema.as_ref().and_then(|schema| {
            let path = std::env::temp_dir().join(format!("controlcode-schema-{}.json", ctx.session_id));
            std::fs::write(&path, schema).ok().map(|_| path)
        });
        if let Some(path) = &schema_file {
            args.push("--output-schema".into());
            args.push(path.to_string_lossy().into_owned());
        }
        args.push("--".into());
        args.push(full_prompt(prompt, ctx, schema_file.is_some()));
        Launch {
            program: crate::agents::agent_command("codex").unwrap_or("codex").to_string(),
            args,
            env: ctx.account_env.clone(),
        }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let mut tally = lock(&self.0);
        match v.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                tally.start(v.get("thread_id").and_then(Value::as_str).map(str::to_string)).into_iter().collect()
            }
            Some("item.completed") => {
                let item = v.get("item").cloned().unwrap_or(Value::Null);
                match item.get("type").and_then(Value::as_str) {
                    Some("agent_message") => {
                        text_event(&mut tally, item.get("text").and_then(Value::as_str).unwrap_or("")).into_iter().collect()
                    }
                    Some("command_execution") => vec![tool_event("Bash", &item)],
                    Some("file_change") => item
                        .get("changes")
                        .and_then(Value::as_array)
                        .map(|changes| changes.iter().map(|c| tool_event("Edit", c)).collect())
                        .unwrap_or_default(),
                    Some("mcp_tool_call") => {
                        let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
                        vec![tool_event(tool, item.get("arguments").unwrap_or(&Value::Null))]
                    }
                    Some("web_search") => vec![tool_event("WebSearch", &item)],
                    Some("error") => {
                        tally.error = item.get("message").and_then(Value::as_str).map(str::to_string);
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            Some("turn.completed") => {
                let n = |p: &str| v.pointer(p).and_then(Value::as_i64);
                tally.add_tokens(n("/usage/input_tokens"), n("/usage/output_tokens"));
                Vec::new()
            }
            Some("turn.failed") => {
                tally.error = v
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some("el turno de Codex falló".into()));
                Vec::new()
            }
            Some("error") => {
                tally.error = v.get("message").and_then(Value::as_str).map(str::to_string);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn finish(&self, emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        emitted.unwrap_or_else(|| lock(&self.0).outcome(code))
    }
}

// ── Gemini CLI ──────────────────────────────────────────────────

/// Verificado contra el código de `@google/gemini-cli` 0.59 (`StreamJsonFormatter` y los
/// eventos que emite `-o stream-json`), no contra una corrida: la cuenta de la máquina ya
/// no tiene acceso al plan gratuito.
#[derive(Default)]
pub struct Gemini(Mutex<Tally>);

impl Gemini {
    /// El texto que venía llegando de a pedazos, completo.
    fn flush(tally: &mut Tally) -> Option<AgentEvent> {
        let text = std::mem::take(&mut tally.pending);
        text_event(tally, &text)
    }
}

impl HeadlessAgent for Gemini {
    fn launch(&self, prompt: &str, model: Option<&str>, _budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        // `auto_edit`: las ediciones pasan y el resto (el shell) queda sin aprobar, que sin
        // terminal es rechazado. `--skip-trust` porque la carpeta de un worktree recién
        // creado nunca fue marcada como confiable, y sin eso Gemini no arranca sin pantalla.
        let mut args: Vec<String> = vec![
            "--prompt".into(),
            full_prompt(prompt, ctx, false),
            "--output-format".into(),
            "stream-json".into(),
            "--approval-mode".into(),
            "auto_edit".into(),
            "--skip-trust".into(),
            // El único además de Claude Code que acepta el id de sesión de afuera.
            "--session-id".into(),
            ctx.session_id.into(),
        ];
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        Launch {
            program: crate::agents::agent_command("gemini-cli").unwrap_or("gemini").to_string(),
            args,
            env: ctx.account_env.clone(),
        }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let mut tally = lock(&self.0);
        match v.get("type").and_then(Value::as_str) {
            Some("init") => {
                tally.start(v.get("session_id").and_then(Value::as_str).map(str::to_string)).into_iter().collect()
            }
            Some("message") if v.get("role").and_then(Value::as_str) == Some("assistant") => {
                let chunk = v.get("content").and_then(Value::as_str).unwrap_or("");
                if v.get("delta").and_then(Value::as_bool) == Some(true) {
                    tally.pending.push_str(chunk);
                    Vec::new()
                } else {
                    tally.pending.clear();
                    text_event(&mut tally, chunk).into_iter().collect()
                }
            }
            Some("tool_use") => {
                let mut out: Vec<AgentEvent> = Self::flush(&mut tally).into_iter().collect();
                let name = v.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
                out.push(tool_event(name, v.get("parameters").unwrap_or(&Value::Null)));
                out
            }
            Some("result") => {
                let mut out: Vec<AgentEvent> = Self::flush(&mut tally).into_iter().collect();
                let n = |p: &str| v.pointer(p).and_then(Value::as_i64);
                tally.add_tokens(n("/stats/input_tokens"), n("/stats/output_tokens"));
                if v.get("status").and_then(Value::as_str) != Some("success") {
                    tally.error = Some(
                        v.pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Gemini terminó con error")
                            .to_string(),
                    );
                }
                let ok = tally.error.is_none();
                out.push(AgentEvent::Finished { outcome: tally.outcome(if ok { 0 } else { 1 }) });
                out
            }
            _ => Vec::new(),
        }
    }

    fn finish(&self, emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        emitted.unwrap_or_else(|| lock(&self.0).outcome(code))
    }
}

// ── Kimi Code ───────────────────────────────────────────────────

/// Según la referencia del comando `kimi` (`--prompt` con `--output-format stream-json`):
/// un mensaje por línea, con la forma de los de chat (`role`, `content`, `tool_calls`). No
/// verificado contra una corrida.
///
/// Ojo con los permisos: `kimi --prompt` corre SIEMPRE con aprobación automática y no
/// acepta otro modo ("cannot be used with --yolo, --auto, or --plan"), así que no hay forma
/// de que pregunte. Es la única de la flota que corre comandos sin que nadie los apruebe.
#[derive(Default)]
pub struct Kimi(Mutex<Tally>);

impl HeadlessAgent for Kimi {
    fn launch(&self, prompt: &str, model: Option<&str>, _budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        let mut args: Vec<String> = vec![
            "--prompt".into(),
            full_prompt(prompt, ctx, false),
            "--output-format".into(),
            "stream-json".into(),
        ];
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        Launch {
            program: crate::agents::agent_command("kimi-code").unwrap_or("kimi").to_string(),
            args,
            env: ctx.account_env.clone(),
        }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let mut tally = lock(&self.0);
        // El id de sesión lo avisa por stderr, no en el stream.
        let mut out: Vec<AgentEvent> = tally.start(None).into_iter().collect();
        if v.get("role").and_then(Value::as_str) != Some("assistant") {
            return out;
        }
        let text = match v.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        out.extend(text_event(&mut tally, &text));
        for call in v.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or("tool");
            // Los argumentos vienen como texto JSON, como en la API de chat.
            let input = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .and_then(|a| serde_json::from_str::<Value>(a).ok())
                .unwrap_or(Value::Null);
            out.push(tool_event(name, &input));
        }
        out
    }

    fn finish(&self, emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        emitted.unwrap_or_else(|| lock(&self.0).outcome(code))
    }
}
