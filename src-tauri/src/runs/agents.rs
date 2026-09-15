//! Cómo se lanza y cómo se lee cada TUI corriendo sin terminal.
//!
//! Lo único que cambia entre agentes es **el argv y el dialecto de eventos**. Todo lo
//! demás —esperar al proceso, matarle la descendencia, escribir el `.jsonl`, contabilizar,
//! cerrar la fila— es igual para todos y vive en `supervisor.rs`. Por eso el trait es de
//! traducción y no de ciclo de vida: un `spawn`/`terminate` por agente sería el mismo
//! código cinco veces.

use std::collections::HashMap;

use super::activity::{text_line, tool_label};
use super::types::{AgentEvent, TaskOutcome};

/// El proceso a lanzar, ya resuelto.
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Lo que hace falta saber para armar el lanzamiento y que no está en la tarea.
pub struct LaunchCtx<'a> {
    /// El id de sesión que la app le IMPONE a la TUI. Se decide antes de lanzar para que
    /// la fila y la sesión queden atadas desde el principio.
    pub session_id: &'a str,
    /// Variables de la cuenta con la que corre (`CLAUDE_CONFIG_DIR` y compañía).
    pub account_env: HashMap<String, String>,
    /// El `--mcp-config` con el puente de permisos de ESTA tarea. `None` = sin broker: el
    /// agente corre con lo que su modo de permisos decida solo.
    pub mcp_config: Option<std::path::PathBuf>,
}

pub trait HeadlessAgent {
    /// argv + env ya resueltos.
    fn launch(&self, prompt: &str, model: Option<&str>, budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch;

    /// Traduce una línea de su stdout. Devuelve varios porque un solo mensaje puede traer
    /// texto y varias herramientas a la vez; vacío = línea sin nada que mostrar.
    fn parse_line(&self, line: &str) -> Vec<AgentEvent>;

    /// El veredicto final. `emitted` es lo que el agente llegó a decir de sí mismo, que
    /// puede no existir: el código de salida es la única señal que siempre está.
    fn finish(&self, emitted: Option<TaskOutcome>, code: i32) -> TaskOutcome {
        match emitted {
            Some(o) => o,
            None if code == 0 => TaskOutcome { ok: true, ..Default::default() },
            None => TaskOutcome::failed(format!("el agente terminó con código {code} sin dar resultado")),
        }
    }
}

/// El adaptador de una TUI concreta.
pub fn adapter_for(agent_id: &str) -> Option<Box<dyn HeadlessAgent + Send + Sync>> {
    match agent_id {
        "claude-code" => Some(Box::new(ClaudeCode)),
        _ => None,
    }
}

// ── Claude Code ─────────────────────────────────────────────────

/// Verificado contra `claude --help` de la 2.1.269 instalada.
pub struct ClaudeCode;

impl HeadlessAgent for ClaudeCode {
    fn launch(&self, prompt: &str, model: Option<&str>, budget_usd: Option<f64>, ctx: &LaunchCtx) -> Launch {
        let mut args = vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            // Sin esto el stream sale recortado en las versiones que todavía lo piden.
            "--verbose".into(),
            // El id lo pone la app, no la TUI: así la fila ya sabe a qué sesión mirar y
            // no hace falta el descubrimiento por mtime que usan las tabs
            // (`sessionDiscovery.ts`, hasta 35 minutos de reintentos).
            "--session-id".into(),
            ctx.session_id.into(),
        ];

        // Nunca `bypassPermissions`: dejar a un agente sin supervisión Y sin límites son
        // dos decisiones distintas, y acá solo se tomó la primera.
        match &ctx.mcp_config {
            // Con broker: el agente PREGUNTA y la consola contesta. `default` es el modo
            // que manda a preguntar las ediciones (las lecturas las resuelve solo, así que
            // no llegan a molestar), y `host` es lo que rutea esa pregunta a nuestra tool.
            // `--strict-mcp-config` deja fuera los MCP del usuario: una tarea desatendida
            // con servidores que no elegimos es superficie que nadie revisó. Los MCP por
            // tarea son la Fase 11.
            Some(path) => {
                args.push("--mcp-config".into());
                args.push(path.to_string_lossy().into_owned());
                args.push("--strict-mcp-config".into());
                args.push("--permission-prompt-tool".into());
                args.push(format!(
                    "mcp__{}__{}",
                    crate::ipc::mcp::SERVER_NAME,
                    crate::ipc::mcp::TOOL_NAME
                ));
                args.push("--permission-mode".into());
                args.push("default".into());
                args.push("--permission-prompts".into());
                args.push("host".into());
                // El navegador de las tabs no pasa por el broker: solo toca la vista
                // previa del proyecto adentro de la app, y pedir permiso por cada click
                // haría imposible que una tarea pruebe una página.
                args.push("--allowedTools".into());
                args.push(crate::ipc::mcp::browser_tool_names().join(","));
            }
            // Sin broker no hay a quién preguntarle, así que lo que preguntaría se DENIEGA
            // en vez de colgar el proceso esperando a nadie.
            None => {
                args.push("--permission-mode".into());
                args.push("acceptEdits".into());
                args.push("--permission-prompts".into());
                args.push("none".into());
            }
        }
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        if let Some(b) = budget_usd {
            // El único presupuesto que la CLI hace cumplir. `--max-turns` no existe en
            // esta versión, así que no hay tope por vueltas.
            //
            // Ojo con qué garantiza: corta la corrida CUANDO YA se pasó, no antes. En una
            // prueba real con tope de 0.05 el cierre informó 0.075 gastados. Sirve para
            // que una tarea desbocada no siga para siempre, no como techo exacto.
            args.push("--max-budget-usd".into());
            args.push(b.to_string());
        }

        Launch {
            program: crate::agents::agent_command("claude-code").unwrap_or("claude").to_string(),
            args,
            env: ctx.account_env.clone(),
        }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        // Tolerante a propósito: el formato del stream puede ganar campos entre versiones,
        // y una línea que no se entiende es una línea que no se muestra — nunca una tarea
        // que se cae. El crudo ya quedó guardado en el `.jsonl` igual.
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return Vec::new() };
        if let Some(quota) = super::quota::parse_rate_limit(&v) {
            return vec![AgentEvent::Quota { quota }];
        }

        match v.get("type").and_then(|t| t.as_str()) {
            // Solo el `init`. Verificado contra una corrida real: hay varios `system` por
            // sesión (`hook_started`, `hook_response`) y tomarlos todos como arranque
            // emitiría tres "arrancó" para una sola tarea.
            Some("system") if v.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                let session_id = v.get("session_id").and_then(|s| s.as_str()).map(str::to_string);
                vec![AgentEvent::Started { session_id }]
            }
            Some("assistant") => {
                let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) else {
                    return Vec::new();
                };
                content
                    .iter()
                    .filter_map(|block| match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => block
                            .get("text")
                            .and_then(|t| t.as_str())
                            .and_then(text_line)
                            .map(|text| AgentEvent::Text { text }),
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str())?;
                            let empty = serde_json::Value::Null;
                            let input = block.get("input").unwrap_or(&empty);
                            Some(AgentEvent::Tool {
                                name: name.to_string(),
                                label: tool_label(name, input),
                            })
                        }
                        _ => None,
                    })
                    .collect()
            }
            Some("result") => {
                let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                let text = v.get("result").and_then(|r| r.as_str()).map(str::to_string);
                // Un cierre con error suele venir SIN texto: el motivo está en el
                // `subtype` (`error_max_budget_usd`, por ejemplo). Sin este respaldo la
                // tarjeta diría "falló" y nada más, que es lo mismo que no decir nada.
                let error = text
                    .clone()
                    .or_else(|| v.get("subtype").and_then(|s| s.as_str()).map(str::to_string));

                vec![AgentEvent::Finished {
                    outcome: TaskOutcome {
                        ok: !is_error,
                        result: if is_error { None } else { text },
                        error: if is_error { error } else { None },
                        cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
                        tokens_in: input_tokens(&v),
                        tokens_out: v.pointer("/usage/output_tokens").and_then(|t| t.as_i64()),
                    },
                }]
            }
            _ => Vec::new(),
        }
    }
}

/// Los tokens de entrada, sumando los de caché.
///
/// `input_tokens` solo cuenta los que NO salieron de la caché de prompt, y en una sesión
/// normal eso es casi cero: en la corrida de prueba dio 0 con decenas de miles realmente
/// consumidos. Se suman los tres, igual que hace `usage/claude.rs` para el panel de
/// consumo de la cuenta, porque el número que le importa a quien mira la tarjeta es
/// cuánto contexto se movió.
fn input_tokens(v: &serde_json::Value) -> Option<i64> {
    let get = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(|t| t.as_i64());
    let parts = [
        get("input_tokens"),
        get("cache_creation_input_tokens"),
        get("cache_read_input_tokens"),
    ];
    parts.iter().any(|p| p.is_some()).then(|| parts.iter().flatten().sum())
}
