//! Las tools SSH que el MCP de la app les ofrece a los agentes.
//!
//! Con ellas un agente que corre en ESTA computadora trabaja en otra: corre comandos allá
//! y copia archivos entre las dos. Solo ve las conexiones que la persona habilitó para
//! agentes, y la única que se aprueba sola es la que las lista: correr o copiar algo en
//! otro equipo lo aprueba la persona cada vez.

use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::exec::{copy, run_remote};
use super::model::{RemoteOutput, SshConnection};
use super::store::{find_by_name, list_conn};
use crate::database::DbConnection;

pub(crate) struct SshTool {
    pub name: &'static str,
    pub description: &'static str,
    pub properties: fn() -> Value,
    pub required: &'static [&'static str],
    /// Solo lee: se puede aprobar sola.
    pub read_only: bool,
}

/// Tope por defecto de un comando remoto, y el máximo que se puede pedir.
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
pub const MAX_TIMEOUT_SECS: u64 = 1800;

pub(crate) const SSH_TOOLS: &[SshTool] = &[
    SshTool {
        name: "ssh_hosts",
        description: "List the other computers the user connected to Control Code over SSH (Settings → Connections) that agents may use: name, user@host, port and default folder. Use the name in ssh_run and ssh_copy.",
        properties: || json!({}),
        required: &[],
        read_only: true,
    },
    SshTool {
        name: "ssh_run",
        description: "Run a shell command on another computer over SSH and get its exit code, stdout and stderr. It runs non-interactively (no password prompts, no TTY): do not start editors, pagers or anything that waits for input, and pass -y style flags. It starts in the connection's default folder unless you pass `cwd`. Each call is a fresh shell: `cd` or variables do not carry over, chain with && instead. Long outputs are cut to their end.",
        properties: || json!({
            "host": { "type": "string", "description": "The connection name, as ssh_hosts lists it." },
            "command": { "type": "string", "description": "Shell command to run there (POSIX shell on Linux/macOS)." },
            "cwd": { "type": "string", "description": "Remote folder to run it in. Default: the connection's folder, or the remote home." },
            "timeout_s": { "type": "number", "description": "Seconds before it is killed (5-1800). Default 120." },
        }),
        required: &["host", "command"],
        read_only: false,
    },
    SshTool {
        name: "ssh_copy",
        description: "Copy files between this computer and another one over SSH (scp). `upload` sends `local` to `remote`; `download` brings `remote` to `local`. Relative local paths are relative to this project's folder; relative remote paths are relative to the remote home.",
        properties: || json!({
            "host": { "type": "string", "description": "The connection name, as ssh_hosts lists it." },
            "direction": { "type": "string", "enum": ["upload", "download"] },
            "local": { "type": "string", "description": "Path on this computer." },
            "remote": { "type": "string", "description": "Path on the other computer." },
            "recursive": { "type": "boolean", "description": "Copy a whole folder. Default: false." },
        }),
        required: &["host", "direction", "local", "remote"],
        read_only: false,
    },
];

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn db(app: &AppHandle) -> Result<tauri::State<'_, DbConnection>, String> {
    app.try_state::<DbConnection>().ok_or_else(|| "database not ready".to_string())
}

/// La conexión que nombra el agente, si la puede usar.
///
/// Una que existe pero no está habilitada para agentes se trata igual que una que no
/// existe, salvo por el mensaje: el agente tiene que poder decirle a la persona qué
/// habilitar, pero no usarla.
pub fn agent_connection(conn: &rusqlite::Connection, name: &str) -> Result<SshConnection, String> {
    match find_by_name(conn, name)? {
        Some(c) if c.agent_access => Ok(c),
        Some(c) => Err(format!(
            "The connection '{}' exists but is not enabled for agents. Ask the user to enable \"Agents can use it\" in Settings → Connections.",
            c.name
        )),
        None => {
            let names: Vec<String> = list_conn(conn)?.into_iter().filter(|c| c.agent_access).map(|c| c.name).collect();
            Err(if names.is_empty() {
                "No SSH connections are available to agents. The user adds them in Control Code → Settings → Connections.".into()
            } else {
                format!("No connection named '{name}'. Available: {}", names.join(", "))
            })
        }
    }
}

/// Una línea por conexión, como la lee un agente.
pub fn hosts_text(connections: &[SshConnection]) -> String {
    let usable: Vec<_> = connections.iter().filter(|c| c.agent_access).collect();
    if usable.is_empty() {
        return "No SSH connections are available to agents. The user adds them in Control Code → Settings → Connections (and enables \"Agents can use it\").".into();
    }
    usable
        .iter()
        .map(|c| {
            let mut line = format!("{} — {}", c.name, super::args::destination(c));
            if let Some(port) = c.port {
                line.push_str(&format!(" port {port}"));
            }
            if let Some(dir) = &c.remote_dir {
                line.push_str(&format!(" (starts in {dir})"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// La salida de un comando como la lee un agente.
pub fn output_text(out: &RemoteOutput) -> String {
    let code = out.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "killed by a signal".into());
    let mut text = format!("exit code: {code}");
    // Un 255 es de `ssh` mismo (no conectó), no del comando: el motivo está en stderr, y
    // el consejo ahorra una ronda de adivinar.
    if out.exit_code == Some(255)
        && let Some(hint) = super::args::hint_for(&out.stderr)
    {
        text.push_str(&format!("\nssh could not connect. {hint}"));
    }
    if !out.stdout.is_empty() {
        text.push_str(&format!("\n--- stdout\n{}", out.stdout.trim_end()));
    }
    if !out.stderr.is_empty() {
        text.push_str(&format!("\n--- stderr\n{}", out.stderr.trim_end()));
    }
    text
}

/// Tope pedido por el agente, dentro de los límites.
pub fn timeout_of(args: &Value) -> Duration {
    let secs = args
        .get("timeout_s")
        .and_then(Value::as_f64)
        .map(|s| s as u64)
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(5, MAX_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Qué carpeta local usa el pedido: la de la tab, o la del worktree de la tarea.
fn local_base(app: &AppHandle, payload: &Value) -> Result<String, String> {
    if let Some(task_id) = payload.get("taskId").and_then(Value::as_str) {
        let conn = db(app)?;
        let conn = conn.lock().map_err(|e| e.to_string())?;
        return conn
            .query_row("SELECT cwd FROM tasks WHERE id = ?1", [task_id], |r| r.get::<_, String>(0))
            .map_err(|_| format!("no task {task_id}"));
    }
    payload.get("cwd").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "missing cwd or taskId".into())
}

/// Una ruta de `scp` que empieza con `-` se leería como opción.
fn safe_path(path: &str, what: &str) -> Result<(), String> {
    if path.starts_with('-') {
        return Err(format!("invalid {what} path"));
    }
    Ok(())
}

fn call(app: &AppHandle, payload: &Value, name: &str, args: &Value) -> Result<String, String> {
    let lookup = |host: &str| -> Result<SshConnection, String> {
        let conn = db(app)?;
        let conn = conn.lock().map_err(|e| e.to_string())?;
        agent_connection(&conn, host)
    };
    match name {
        "ssh_hosts" => {
            let conn = db(app)?;
            let conn = conn.lock().map_err(|e| e.to_string())?;
            Ok(hosts_text(&list_conn(&conn)?))
        }
        "ssh_run" => {
            let c = lookup(arg_str(args, "host").ok_or("missing `host`")?)?;
            let command = args.get("command").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).ok_or("missing `command`")?;
            let out = run_remote(&c, command, arg_str(args, "cwd"), timeout_of(args))?;
            Ok(output_text(&out))
        }
        "ssh_copy" => {
            let c = lookup(arg_str(args, "host").ok_or("missing `host`")?)?;
            let local = arg_str(args, "local").ok_or("missing `local`")?;
            let remote = arg_str(args, "remote").ok_or("missing `remote`")?;
            safe_path(local, "local")?;
            safe_path(remote, "remote")?;
            let base = local_base(app, payload)?;
            let local = Path::new(&base).join(local).to_string_lossy().into_owned();
            let remote = super::args::scp_remote(&c, remote);
            let recursive = args.get("recursive").and_then(Value::as_bool).unwrap_or(false);
            let (from, to) = match arg_str(args, "direction") {
                Some("upload") => (local, remote),
                Some("download") => (remote, local),
                _ => return Err("`direction` must be upload or download".into()),
            };
            let out = copy(&c, &from, &to, recursive, Duration::from_secs(MAX_TIMEOUT_SECS))?;
            if out.exit_code == Some(0) {
                Ok(format!("Copied {from} → {to}"))
            } else {
                Err(format!("scp failed.\n{}", output_text(&out)))
            }
        }
        other => Err(format!("unknown ssh tool {other}")),
    }
}

/// Lo que recibe la app desde `ccode mcp`: `{cwd|taskId, tool, args}`. Corre en un hilo
/// del servidor IPC, así que puede bloquear mientras `ssh` trabaja.
pub(crate) fn run(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let tool = payload.get("tool").and_then(Value::as_str).ok_or("missing tool")?.to_string();
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    call(app, payload, &tool, &args).map(|text| json!({ "text": text }))
}

/// `ccode ssh list`: las conexiones que pueden usar los agentes, como datos.
pub(crate) fn cli_list(app: &AppHandle) -> Result<Value, String> {
    let conn = db(app)?;
    let conn = conn.lock().map_err(|e| e.to_string())?;
    let list: Vec<Value> = list_conn(&conn)?
        .into_iter()
        .filter(|c| c.agent_access)
        .map(|c| {
            json!({
                "name": c.name,
                "destination": super::args::destination(&c),
                "port": c.port,
                "remoteDir": c.remote_dir,
            })
        })
        .collect();
    Ok(json!(list))
}

/// `ccode ssh run <conexión> "<comando>" [--cwd dir] [--timeout 120]`.
pub(crate) fn cli_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let host = arg_str(args, "host").ok_or("Falta el argumento --host")?;
    let command = arg_str(args, "command").ok_or("Falta el argumento --command")?;
    let c = {
        let conn = db(app)?;
        let conn = conn.lock().map_err(|e| e.to_string())?;
        agent_connection(&conn, host)?
    };
    // La tool lo llama `timeout_s`; en la CLI es `--timeout`, como en `watch wait`.
    let timeout = args.get("timeout").map(|t| json!({ "timeout_s": t })).unwrap_or(Value::Null);
    let out = run_remote(&c, command, arg_str(args, "cwd"), timeout_of(&timeout))?;
    serde_json::to_value(out).map_err(|e| e.to_string())
}
