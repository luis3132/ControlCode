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
    /// `default`, `acceptEdits`, `plan` o `bypassPermissions`.
    pub permission_mode: Option<String>,
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
    Events { events: Vec<ChatEvent> },
    /// El proceso terminó. `stopped` = lo paró la persona.
    Ended { code: Option<i32>, stopped: bool, stderr: String },
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
pub fn stop(tab_id: &str) -> bool {
    let mut map = live();
    let Some(entry) = map.get_mut(tab_id) else { return false };
    entry.stopped = true;
    entry.group.kill_all();
    drop(map);
    // Lo que esperaba una decisión ya no tiene a quién contestarle.
    crate::runs::drop_tab_approvals(tab_id);
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
    let mode = turn.permission_mode.as_deref().filter(|m| is_permission_mode(m)).unwrap_or("default");
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

pub fn is_permission_mode(mode: &str) -> bool {
    matches!(mode, "default" | "acceptEdits" | "plan" | "bypassPermissions")
}

/// La línea que se le escribe por stdin.
pub fn user_line(content: &[Value]) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

/// Un argumento listo para ir dentro del script de un shell.
#[cfg(unix)]
fn quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:,@+".contains(c)) {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', r"'\''"))
}

#[cfg(windows)]
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || "\"&|<>^()%!,;".contains(c)) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\"\""))
}

/// El proceso a lanzar: `claude` directo o, con pasos previos, un shell que los corre y
/// termina en `claude` (como las tabs: `conda activate` es una función de shell).
fn command_for(program: &std::ffi::OsStr, args: &[String], prelaunch: &[String]) -> tokio::process::Command {
    if prelaunch.is_empty() {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args);
        return cmd;
    }
    let line = std::iter::once(quote(&program.to_string_lossy()))
        .chain(args.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = tokio::process::Command::new(shell);
        cmd.arg("-l").arg("-c").arg(format!("{} && exec {line}", prelaunch.join(" && ")));
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").arg(format!("{} && {line}", prelaunch.join(" && ")));
        cmd
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
        let mut map = live();
        if map.contains_key(&turn.tab_id) {
            return Err("esta tab ya tiene un turno en curso".into());
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
        map.insert(turn.tab_id.clone(), Live { group, stopped: false });
        drop(map);

        let app = app.clone();
        let tab_id = turn.tab_id.clone();
        let line = user_line(&turn.content);
        tokio::spawn(async move {
            run(app, tab_id, child, line, stdin, stdout, stderr).await;
        });
    }
    Ok(())
}

async fn run<R: Runtime>(
    app: AppHandle<R>,
    tab_id: String,
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
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let events = parse::parse_line(&l);
            if !events.is_empty() {
                let _ = app.emit(&name, ChatEnvelope::Events { events });
            }
        }
    }

    let code = child.wait().await.ok().and_then(|s| s.code());
    let stderr = err_task.await.unwrap_or_default();
    // Sacarlo del registro corre el `Drop` del grupo: barre lo que el turno dejó andando.
    let stopped = live().remove(&tab_id).map(|l| l.stopped).unwrap_or(true);
    crate::runs::drop_tab_approvals(&tab_id);
    let _ = app.emit(&name, ChatEnvelope::Ended { code, stopped, stderr: tail(&stderr, 2000) });
}
