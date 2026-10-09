//! Los turnos de las tabs en modo HTML: un proceso `claude -p` por mensaje.
//!
//! ## Por qué un proceso por turno
//!
//! El Agent SDK habla con un `claude` vivo por stdin/stdout con un protocolo de control
//! (interrumpir, cambiar el modelo, contestar permisos) que no está documentado y puede
//! cambiar en cualquier versión. Acá no se usa: cada mensaje lanza `claude -p --resume`,
//! se le escribe el mensaje por stdin y se lee hasta que termina. Interrumpir es matar el
//! proceso (lo ya hecho queda guardado en la sesión), y el modelo o el modo de permisos
//! son flags del turno siguiente. Cuesta un arranque por mensaje; a cambio no depende de
//! nada interno, y es lo mismo que hace la flota.
//!
//! Regla que se cuida desde el frontend: nunca dos procesos sobre la misma sesión. Al
//! volver a la consola, primero se para el turno y después arranca la TUI con `--resume`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::terminal::containment::ProcessGroup;

use super::launch::command_for;
use super::parse::{self, ChatEvent};

/// Lo que el frontend resuelve antes de cada turno: la cuenta, los pasos previos y la
/// sesión, igual que `Terminal.tsx` antes de lanzar la TUI.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub tab_id: String,
    pub cwd: String,
    /// La sesión de la tab. Con `resume` se continúa; sin él, se crea con este id.
    pub session_id: String,
    pub resume: bool,
    pub model: Option<String>,
    /// Cuánto puede pensar: `low`, `medium`, `high`, `xhigh` o `max`.
    pub effort: Option<String>,
    /// `default`, `acceptEdits`, `plan` o `bypassPermissions`.
    pub permission_mode: Option<String>,
    /// Una pregunta al margen (`/btw`): corre sobre una COPIA de la conversación
    /// (`--fork-session`), así que la ve entera y no le agrega nada. Sin permiso de
    /// escribir y sin puente de permisos: una pregunta no toca archivos.
    #[serde(default)]
    pub side: bool,
    /// El mensaje: bloques `text` e `image` de la API.
    pub content: Vec<Value>,
    /// Las de la cuenta y las de la TUI custom.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Los pasos previos ya resueltos (ver el módulo `prelaunch`).
    #[serde(default)]
    pub prelaunch: Vec<String>,
}

/// Lo que viaja por `chat-event-<tabId>`.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEnvelope {
    /// Lo que dijo el agente, ya traducido. Varios por línea.
    Events { events: Vec<ChatEvent>, side: bool },
    /// El proceso terminó. `stopped` = lo paró la persona.
    Ended { code: Option<i32>, stopped: bool, stderr: String, side: bool },
}

pub fn event_name(tab_id: &str) -> String {
    format!("chat-event-{tab_id}")
}

/// El nombre que tiene que tener una tab para viajar en un nombre de evento.
fn valid_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

struct Live {
    group: ProcessGroup,
    stopped: bool,
}

static SEQ: AtomicU32 = AtomicU32::new(1);

lazy_static::lazy_static! {
    /// El turno en curso de cada tab.
    static ref LIVE: Mutex<HashMap<String, Live>> = Mutex::new(HashMap::new());
}

fn live() -> std::sync::MutexGuard<'static, HashMap<String, Live>> {
    LIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// La clave del registro. Una pregunta al margen va aparte: puede correr mientras la
/// conversación trabaja, que es justamente para lo que sirve.
fn live_key(tab_id: &str, side: bool) -> String {
    if side { format!("{tab_id}#btw") } else { tab_id.to_string() }
}

pub fn is_running(tab_id: &str) -> bool {
    live().contains_key(tab_id)
}

/// Mata todos los turnos vivos. Se llama al salir, junto con las terminales.
pub fn kill_all() {
    let groups: Vec<Live> = live().drain().map(|(_, l)| l).collect();
    for mut l in groups {
        l.group.kill_all();
    }
}

/// Para el turno de una tab. `false` si no había ninguno.
pub fn stop(tab_id: &str, side: bool) -> bool {
    let mut map = live();
    let Some(entry) = map.get_mut(&live_key(tab_id, side)) else { return false };
    entry.stopped = true;
    entry.group.kill_all();
    drop(map);
    // Lo que esperaba una decisión ya no tiene a quién contestarle. Una pregunta al margen
    // no tiene puente de permisos, así que no deja nada esperando.
    if !side {
        crate::runs::drop_tab_approvals(tab_id);
    }
    true
}

/// Los argumentos de `claude` para un turno.
///
/// `mcp` es el `--mcp-config` de la tab con el puente de permisos y lo que se aprueba solo;
/// sin él (una build sin `ccode`) no hay a quién preguntar, y lo que preguntaría se deniega
/// en vez de dejar el proceso colgado.
pub fn claude_args(turn: &ChatTurn, mcp: Option<(&str, &[String])>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Los deltas: el texto aparece mientras se escribe, no al final de cada bloque.
        "--include-partial-messages",
    ]
    .map(String::from)
    .to_vec();
    args.push(if turn.resume { "--resume" } else { "--session-id" }.into());
    args.push(turn.session_id.clone());
    if let Some(model) = turn.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(effort) = turn.effort.as_deref().filter(|e| is_effort(e)) {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if turn.side {
        // La copia: la pregunta ve la conversación entera y la original no se entera.
        args.push("--fork-session".into());
        // Nadie va a contestar: no hay puente de permisos ni tarjeta para responder. Una
        // pregunta del modelo (o un plan que espera aprobación) dejaba la tarjeta colgada
        // sin respuesta, así que esas herramientas no existen acá, y se le dice que conteste.
        args.push("--disallowedTools".into());
        args.push(SIDE_DISALLOWED.join(","));
        args.push("--append-system-prompt".into());
        args.push(SIDE_PROMPT.into());
    }
    // Una pregunta al margen no escribe. `plan` es el único modo que lo garantiza del lado
    // de la TUI, y sin puente de permisos (ver `chat_send`) lo que pidiera se niega solo.
    let mode = if turn.side {
        "plan"
    } else {
        turn.permission_mode.as_deref().filter(|m| is_permission_mode(m)).unwrap_or("default")
    };
    args.push("--permission-mode".into());
    args.push(mode.into());
    match mcp {
        Some((config, allowed)) => {
            args.push("--mcp-config".into());
            args.push(config.into());
            args.push("--permission-prompt-tool".into());
            args.push(format!("mcp__{}__{}", crate::ipc::mcp::SERVER_NAME, crate::ipc::mcp::TOOL_NAME));
            args.push("--permission-prompts".into());
            args.push("host".into());
            if !allowed.is_empty() {
                args.push("--allowedTools".into());
                args.push(allowed.join(","));
            }
        }
        None => {
            args.push("--permission-prompts".into());
            args.push("none".into());
        }
    }
    args
}

/// Lo que una pregunta al margen no puede usar: todo lo que espera a una persona.
pub const SIDE_DISALLOWED: &[&str] = &["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"];

const SIDE_PROMPT: &str = "This is a side question (/btw) the user asked while the main conversation goes on. \
Answer it directly and briefly from what you already know of the conversation. Do not ask the user anything, \
do not write a plan and do not change files: there is no one to approve them, and this answer is not added to \
the main conversation.";

pub fn is_permission_mode(mode: &str) -> bool {
    matches!(mode, "default" | "acceptEdits" | "plan" | "bypassPermissions")
}

/// Los niveles que acepta `claude --effort`, verificado contra el `--help` de la 2.1.293.
pub fn is_effort(level: &str) -> bool {
    matches!(level, "low" | "medium" | "high" | "xhigh" | "max")
}

/// La línea que se le escribe por stdin.
pub fn user_line(content: &[Value]) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

/// Cada cuánto sale una tanda de eventos al chat mientras el agente escribe: lo bastante
/// seguido para que el texto se vea fluir, lo bastante espaciado para no redibujar el chat
/// decenas de veces por segundo.
const FLUSH_EVERY: std::time::Duration = std::time::Duration::from_millis(50);

/// Agrega eventos a una tanda, pegando los pedacitos de texto (o de razonamiento) seguidos
/// del mismo origen en uno solo: el chat los dibuja igual, y son muchas menos operaciones.
pub fn push_merged(batch: &mut Vec<ChatEvent>, events: Vec<ChatEvent>) {
    for event in events {
        match (batch.last_mut(), event) {
            (
                Some(ChatEvent::TextDelta { text: acc, parent: p0 }),
                ChatEvent::TextDelta { text, parent },
            ) if *p0 == parent => acc.push_str(&text),
            (
                Some(ChatEvent::ThinkingDelta { text: acc, parent: p0 }),
                ChatEvent::ThinkingDelta { text, parent },
            ) if *p0 == parent => acc.push_str(&text),
            // El uso que va subiendo: solo importa el último de cada tanda.
            (Some(ChatEvent::Usage { input_tokens: i0, output_tokens: o0 }), ChatEvent::Usage { input_tokens, output_tokens }) => {
                *i0 = input_tokens.or(*i0);
                *o0 = output_tokens.or(*o0);
            }
            (_, event) => batch.push(event),
        }
    }
}

/// Las últimas `max` letras: el final de un stderr es donde está el error.
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    format!("…{}", s.chars().skip(n - max).collect::<String>())
}

/// Lanza un turno. Vuelve en cuanto el proceso quedó andando; lo demás llega por eventos.
///
/// `program` y `args` los arma [`super::commands`]; se reciben de afuera para poder probar
/// esto con un proceso falso.
pub fn start<R: Runtime>(
    app: &AppHandle<R>,
    turn: ChatTurn,
    program: std::ffi::OsString,
    args: Vec<String>,
) -> Result<(), String> {
    if !valid_tab_id(&turn.tab_id) {
        return Err(format!("'{}' no es un id de tab", turn.tab_id));
    }
    if turn.content.is_empty() {
        return Err("el mensaje está vacío".into());
    }
    let runtime = tauri::async_runtime::handle();
    let _inside = runtime.inner().enter();

    // Se reserva el lugar antes de lanzar: dos clicks seguidos en "enviar" no pueden
    // terminar en dos procesos escribiendo la misma sesión.
    let mut group = ProcessGroup::new(SEQ.fetch_add(1, Ordering::Relaxed));
    {
        let key = live_key(&turn.tab_id, turn.side);
        let mut map = live();
        if map.contains_key(&key) {
            return Err(if turn.side {
                "esta tab ya tiene una pregunta al margen en curso".into()
            } else {
                "esta tab ya tiene un turno en curso".to_string()
            });
        }
        let mut cmd = command_for(&program, &args, &turn.prelaunch);
        cmd.current_dir(&turn.cwd)
            .envs(&turn.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("no se pudo lanzar '{}': {e}", program.to_string_lossy()))?;
        group.adopt(&child);

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        map.insert(key, Live { group, stopped: false });
        drop(map);

        let app = app.clone();
        let tab_id = turn.tab_id.clone();
        let side = turn.side;
        let line = user_line(&turn.content);
        tokio::spawn(async move {
            run(app, tab_id, side, child, line, stdin, stdout, stderr).await;
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run<R: Runtime>(
    app: AppHandle<R>,
    tab_id: String,
    side: bool,
    mut child: tokio::process::Child,
    line: String,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) {
    let name = event_name(&tab_id);

    // El mensaje, y se cierra stdin: con `-p` eso le dice que no hay nada más que esperar.
    if let Some(mut input) = stdin {
        let _ = input.write_all(line.as_bytes()).await;
        let _ = input.write_all(b"\n").await;
        let _ = input.shutdown().await;
    }

    // stderr se junta EN PARALELO: si se leyera al final y el proceso escribe mucho ahí,
    // se llena el pipe, el proceso se traba y stdout no termina nunca.
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).trim().to_string()
    });

    if let Some(out) = stdout {
        // En tandas y no línea por línea: con `--include-partial-messages` llegan decenas
        // de pedacitos de texto por segundo, y un evento por cada uno hacía redibujar el
        // chat otras tantas veces. Se junta lo que llega en `FLUSH_EVERY` y se manda junto,
        // con los pedacitos de texto seguidos ya pegados.
        let mut lines = BufReader::new(out).lines();
        let mut batch: Vec<ChatEvent> = Vec::new();
        let mut since = tokio::time::Instant::now();
        loop {
            let wait = FLUSH_EVERY.saturating_sub(since.elapsed());
            let next = if batch.is_empty() {
                lines.next_line().await.map(Some)
            } else {
                match tokio::time::timeout(wait, lines.next_line()).await {
                    Ok(read) => read.map(Some),
                    // Pasó el tiempo sin nada nuevo: lo juntado sale ya.
                    Err(_) => Ok(None),
                }
            };
            match next {
                Ok(Some(Some(l))) => {
                    if batch.is_empty() {
                        since = tokio::time::Instant::now();
                    }
                    push_merged(&mut batch, parse::parse_line(&l));
                }
                Ok(None) => {}
                // Se cerró stdout (o falló la lectura): lo que quede sale y se termina.
                Ok(Some(None)) | Err(_) => break,
            }
            if !batch.is_empty() && since.elapsed() >= FLUSH_EVERY {
                let events = std::mem::take(&mut batch);
                let _ = app.emit(&name, ChatEnvelope::Events { events, side });
            }
        }
        if !batch.is_empty() {
            let _ = app.emit(&name, ChatEnvelope::Events { events: batch, side });
        }
    }

    let code = child.wait().await.ok().and_then(|s| s.code());
    let stderr = err_task.await.unwrap_or_default();
    // Sacarlo del registro corre el `Drop` del grupo: barre lo que el turno dejó andando.
    let stopped = live().remove(&live_key(&tab_id, side)).map(|l| l.stopped).unwrap_or(true);
    if !side {
        crate::runs::drop_tab_approvals(&tab_id);
    }
    let _ = app.emit(&name, ChatEnvelope::Ended { code, stopped, stderr: tail(&stderr, 2000), side });
}
