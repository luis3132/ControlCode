//! Las dos puertas a los subprocesos: el despachador (`proc.*`, lo que piden los agentes
//! por el MCP y la CLI `ccode proc`) y los comandos de la sección Subprocesos.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::logs::{self, Query, Until, Waited};
use super::stats::{self, Usage};
use super::{Owner, StartSpec, Status, Subprocess};
use crate::database::DbConnection;

/// Tope de una espera, la pida quien la pida.
const MAX_WAIT_SECS: u64 = 1800;
/// Lo que espera `process_start` sin `wait_for`: lo justo para devolver el error de un
/// comando que falla al arrancar (no existe, puerto ocupado) en vez de "corriendo".
const START_SETTLE: Duration = Duration::from_millis(1500);

/// Quién pide, y por lo tanto qué workspace ve y desde dónde lanza.
struct Caller {
    workspace: String,
    cwd: String,
    owner: Owner,
    /// La llave de sus lecturas: dos agentes leyendo el mismo log no se pisan "lo nuevo".
    reader: String,
}

fn caller(app: &AppHandle, payload: &Value) -> Result<Caller, String> {
    if let Some(task_id) = payload.get("taskId").and_then(Value::as_str) {
        let db = app.try_state::<DbConnection>().ok_or("la base no está disponible")?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        let (workspace, cwd) = crate::runs::task_folders(&conn, task_id)?;
        return Ok(Caller {
            workspace,
            cwd,
            owner: Owner { tab_id: None, task_id: Some(task_id.to_string()) },
            reader: format!("task:{task_id}"),
        });
    }
    let cwd = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).ok_or("falta desde qué carpeta se pide (cwd)")?;
    let tab = payload.get("tabId").and_then(Value::as_str).map(str::to_string);
    Ok(Caller {
        workspace: cwd.to_string(),
        cwd: cwd.to_string(),
        reader: tab.as_ref().map_or_else(|| format!("cwd:{cwd}"), |t| format!("tab:{t}")),
        owner: Owner { tab_id: tab, task_id: None },
    })
}

/// Los parámetros: el MCP los manda bajo `args` (junto a quién pide), la CLI sueltos.
fn params(payload: &Value) -> &Value {
    payload.get("args").filter(|a| a.is_object()).unwrap_or(payload)
}

fn str_param<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn num_param(p: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| p.get(*k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
}

fn bool_param(p: &Value, key: &str) -> bool {
    p.get(key).and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true"))).unwrap_or(false)
}

/// El subproceso `id`, siempre que sea del workspace de quien pide.
fn owned(caller: &Caller, id: &str) -> Result<Subprocess, String> {
    let proc = super::get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
    if !super::same_folder(&proc.workspace, &caller.workspace) {
        return Err(format!("{id} es de otro workspace ({})", proc.workspace));
    }
    Ok(proc)
}

/// Una ruta del agente, relativa a su carpeta si no es absoluta.
fn resolve_cwd(caller: &Caller, asked: Option<&str>) -> String {
    match asked {
        None => caller.cwd.clone(),
        Some(path) if std::path::Path::new(path).is_absolute() => path.to_string(),
        Some(path) => std::path::Path::new(&caller.cwd).join(path).to_string_lossy().into_owned(),
    }
}

fn regex(pattern: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern).case_insensitive(true).build().map_err(|e| format!("patrón inválido: {e}"))
}

fn uptime(proc: &Subprocess) -> String {
    let end = proc.ended_at.unwrap_or_else(super::now_ms);
    let secs = end.saturating_sub(proc.started_at) / 1000;
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m{}s", secs / 60, secs % 60),
        _ => format!("{}h{}m", secs / 3600, (secs % 3600) / 60),
    }
}

fn mb(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// El uso de los que corren, por id de subproceso.
fn usage_by_id(procs: &[Subprocess]) -> HashMap<String, Usage> {
    let roots: Vec<(String, u32)> = procs
        .iter()
        .filter(|p| p.status == Status::Running)
        .filter_map(|p| crate::terminal::process_id(p.pty_id).map(|pid| (p.id.clone(), pid)))
        .collect();
    let by_pid = stats::usage_of(&roots.iter().map(|(_, pid)| *pid).collect::<Vec<_>>());
    roots.into_iter().filter_map(|(id, pid)| by_pid.get(&pid).map(|u| (id, *u))).collect()
}

fn text(body: String, data: Value) -> Value {
    let mut out = data;
    out["text"] = json!(body);
    out
}

/// Lo que piden los agentes. `command` es `proc.<acción>`.
pub fn handle(app: &AppHandle, command: &str, payload: &Value) -> Result<Value, String> {
    let caller = caller(app, payload)?;
    let p = params(payload);
    let call_id = payload.get("callId").and_then(Value::as_str).map(str::to_string);
    let cancelled = move || crate::ipc::cancel::is_cancelled(call_id.as_deref());

    match command {
        "proc.start" => {
            let command = str_param(p, "command").ok_or("falta el comando (command)")?;
            let proc = super::start(StartSpec {
                command: command.to_string(),
                cwd: resolve_cwd(&caller, str_param(p, "cwd")),
                name: str_param(p, "name").map(str::to_string),
                workspace: caller.workspace.clone(),
                owner: caller.owner.clone(),
            })?;
            let waited = match str_param(p, "waitFor").or_else(|| str_param(p, "wait_for")) {
                Some(pattern) => {
                    let secs = num_param(p, &["timeoutSecs", "timeout_s", "timeout"]).unwrap_or(60).min(MAX_WAIT_SECS);
                    Some(logs::wait(&proc.id, &Until::Pattern(regex(pattern)?), Duration::from_secs(secs), Some(0), &cancelled)?)
                }
                None => {
                    // Un rato corto: si murió enseguida, que se sepa ya.
                    logs::wait(&proc.id, &Until::Exit, START_SETTLE, Some(0), &cancelled)?;
                    None
                }
            };
            let proc = super::get(&proc.id).unwrap_or(proc);
            let note = match &waited {
                Some(Waited::Matched(line)) => format!("Ready: matched \"{line}\"."),
                Some(Waited::TimedOut) => "Still running, but the wait_for pattern did not appear before the timeout.".into(),
                Some(Waited::Exited) => "It exited before the wait_for pattern appeared.".into(),
                Some(Waited::Cancelled) => "Wait cancelled; it keeps running.".into(),
                Some(Waited::Idle) | None => match proc.status {
                    Status::Running => "Started. It keeps running in the background; read its logs with process_output.".into(),
                    _ => "It exited right away.".into(),
                },
            };
            let output = logs::read(&caller.reader, &proc.id, &Query { lines: Some(30), ..Default::default() })?;
            Ok(text(format!("{note}\n{output}"), json!({ "process": proc })))
        }
        "proc.list" => {
            let all = bool_param(p, "all");
            let procs = super::list(if all { None } else { Some(&caller.workspace) });
            let usage = usage_by_id(&procs);
            if procs.is_empty() {
                return Ok(text("No subprocesses in this workspace. Start one with process_start.".into(), json!({ "processes": [] })));
            }
            let lines: Vec<String> = procs
                .iter()
                .map(|proc| {
                    let mut line = format!("{} — {}", logs::status_line(proc), uptime(proc));
                    if let Some(u) = usage.get(&proc.id) {
                        line.push_str(&format!(", {:.0}% CPU, {}", u.cpu, mb(u.memory)));
                    }
                    let errors = logs::unread_errors(&caller.reader, proc);
                    if errors > 0 {
                        line.push_str(&format!(", {errors} unread error line(s)"));
                    }
                    line
                })
                .collect();
            let data: Vec<Value> = procs
                .iter()
                .map(|proc| json!({ "process": proc, "usage": usage.get(&proc.id) }))
                .collect();
            Ok(text(lines.join("\n"), json!({ "processes": data })))
        }
        "proc.output" => {
            let id = str_param(p, "id").ok_or("falta el subproceso (id)")?;
            owned(&caller, id)?;
            let query = Query {
                lines: num_param(p, &["lines"]).map(|n| n as usize),
                grep: str_param(p, "grep").map(str::to_string),
                errors: bool_param(p, "errors"),
            };
            Ok(text(logs::read(&caller.reader, id, &query)?, json!({})))
        }
        "proc.wait" => {
            let id = str_param(p, "id").ok_or("falta el subproceso (id)")?;
            owned(&caller, id)?;
            let secs = num_param(p, &["timeoutSecs", "timeout_s", "timeout"]).unwrap_or(120).min(MAX_WAIT_SECS);
            let until = match str_param(p, "until").unwrap_or("exit") {
                "pattern" => Until::Pattern(regex(str_param(p, "pattern").ok_or("falta el patrón (pattern)")?)?),
                "idle" => Until::Idle(Duration::from_secs(num_param(p, &["idleSecs", "idle_s"]).unwrap_or(3).max(1))),
                "exit" => Until::Exit,
                other => return Err(format!("'{other}' no es algo que se pueda esperar (exit, pattern, idle)")),
            };
            let from = matches!(until, Until::Pattern(_)).then(|| logs::cursor_of(&caller.reader, id));
            let waited = logs::wait(id, &until, Duration::from_secs(secs), from, &cancelled)?;
            let note = match waited {
                Waited::Matched(line) => format!("Matched: \"{line}\"."),
                Waited::Exited => "It is no longer running.".into(),
                Waited::Idle => "It went quiet.".into(),
                Waited::TimedOut => format!("Timed out after {secs}s; it is still running."),
                Waited::Cancelled => "Wait cancelled.".into(),
            };
            let output = logs::read(&caller.reader, id, &Query::default())?;
            Ok(text(format!("{note}\n{output}"), json!({})))
        }
        "proc.send" => {
            let id = str_param(p, "id").ok_or("falta el subproceso (id)")?;
            owned(&caller, id)?;
            let input = p.get("text").and_then(Value::as_str).ok_or("falta el texto (text)")?;
            let enter = p.get("enter").and_then(Value::as_bool).unwrap_or(true) && !bool_param(p, "noEnter");
            super::send(id, input, enter)?;
            Ok(text(format!("Sent to {id}."), json!({})))
        }
        "proc.stop" => {
            let id = str_param(p, "id").ok_or("falta el subproceso (id)")?;
            owned(&caller, id)?;
            let proc = super::stop(id, bool_param(p, "force"))?;
            Ok(text(logs::status_line(&proc), json!({ "process": proc })))
        }
        "proc.restart" => {
            let id = str_param(p, "id").ok_or("falta el subproceso (id)")?;
            owned(&caller, id)?;
            let proc = super::restart(id)?;
            Ok(text(format!("Restarted.\n{}", logs::status_line(&proc)), json!({ "process": proc })))
        }
        other => Err(format!("Comando desconocido: {other}")),
    }
}

// ── La sección Subprocesos ──────────────────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn procs_list() -> Vec<Subprocess> {
    super::list(None)
}

/// Lanzado por la persona desde la sección: es del workspace de la carpeta.
#[tauri::command]
pub async fn procs_start(command: String, cwd: String, name: Option<String>) -> Result<Subprocess, String> {
    blocking(move || {
        super::start(StartSpec { command, workspace: cwd.clone(), cwd, name, owner: Owner::default() })
    })
    .await
}

#[tauri::command]
pub async fn procs_stop(id: String, force: bool) -> Result<Subprocess, String> {
    blocking(move || super::stop(&id, force)).await
}

#[tauri::command]
pub async fn procs_restart(id: String) -> Result<Subprocess, String> {
    blocking(move || super::restart(&id)).await
}

/// Olvida los terminados (uno, o todos con `id` vacío).
#[tauri::command]
pub fn procs_clear(id: Option<String>) -> usize {
    super::clear(id.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcUsage {
    pub id: String,
    #[serde(flatten)]
    pub usage: Usage,
}

/// CPU y memoria de los que corren. Lo pide la sección mientras está abierta.
#[tauri::command]
pub async fn procs_usage() -> Result<Vec<ProcUsage>, String> {
    blocking(|| {
        let procs = super::list(None);
        Ok(usage_by_id(&procs).into_iter().map(|(id, usage)| ProcUsage { id, usage }).collect())
    })
    .await
}
