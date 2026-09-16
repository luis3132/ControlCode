//! Lanzar una tarea, seguirla mientras corre y cerrarla.
//!
//! Es lo único común a todos los agentes: esperar al proceso, contener su descendencia,
//! guardar el crudo, traducir eventos y escribir el veredicto. Lo que cambia entre TUIs
//! —el argv y el dialecto— está en `agents.rs`.
//!
//! ## Por qué acá sí `tokio::spawn`
//!
//! Es el primero del crate. El resto de la app usa `spawn_blocking` porque `portable-pty`
//! expone un `Read` bloqueante (ver `pty_manager.rs`), y una lectura bloqueante en un
//! worker async lo secuestra. Un hijo de `tokio::process` con el stdout redirigido es un
//! stream async de verdad, así que esa objeción no aplica — y un hilo de OS por agente de
//! la flota sería desperdicio puro.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::database::DbConnection;
use crate::terminal::containment::ProcessGroup;

use super::agents::{adapter_for, LaunchCtx};
use super::store;
use super::types::{status, AgentEvent, Task, TaskOutcome};

/// Evento que la consola escucha para pintar la actividad viva de una tarjeta.
pub const TASK_EVENT: &str = "cc-task-event";
/// Evento de "esta tarjeta cambió de estado"; la consola recarga esa fila.
pub const TASK_CHANGED: &str = "cc-task-changed";
/// Evento de "cambió la cola de permisos"; la consola vuelve a pedirla.
pub const APPROVALS_CHANGED: &str = "cc-task-approvals";

/// Avisa que la cola de permisos cambió. Se manda el estado entero y no el delta porque
/// son unos pocos pedidos y así una ventana que se perdió un evento se recupera sola.
pub fn notify_approvals(app: &AppHandle) {
    let _ = app.emit(APPROVALS_CHANGED, super::broker::pending());
}

/// Nombre del grupo de contención. No se cruza con los ids de PTY porque va por otro
/// contador y el nombre del cgroup los distingue igual; solo sirve para leerlo.
static GROUP_SEQ: AtomicU32 = AtomicU32::new(1);

lazy_static::lazy_static! {
    /// El grupo de contención de cada tarea viva.
    ///
    /// Sin esto `cancel` no tendría a qué matar: el grupo se crea al lanzar y viaja dentro
    /// de la tarea async que espera al proceso, que desde afuera es inalcanzable. Es el
    /// mismo patrón que `PTY_REGISTRY` en `pty_manager`, y por el mismo motivo.
    static ref LIVE: Mutex<HashMap<String, ProcessGroup>> = Mutex::new(HashMap::new());
}

fn live() -> std::sync::MutexGuard<'static, HashMap<String, ProcessGroup>> {
    // Igual que en el resto del crate: un panic aislado no debe dejar inutilizable al
    // registro entero.
    LIVE.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskEventPayload {
    task_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

fn emit_event(app: &AppHandle, task_id: &str, event: AgentEvent) {
    let _ = app.emit(TASK_EVENT, TaskEventPayload { task_id: task_id.to_string(), event });
}

fn emit_changed(app: &AppHandle, task_id: &str) {
    let _ = app.emit(TASK_CHANGED, task_id.to_string());
}

/// Avisa a la consola que una fila cambió por algo que no pasó en el proceso (descartar su
/// worktree, por ejemplo).
pub fn notify_changed(app: &AppHandle, task_id: &str) {
    emit_changed(app, task_id);
}

/// El `--mcp-config` que le dice al agente cómo alcanzar su puente de permisos y el
/// navegador.
///
/// Se escribe uno por tarea porque el `--task` de adentro es lo que después le dice a la
/// app a qué tarjeta pertenece cada pedido. El archivo se borra al terminar; los que
/// queden de un cierre sucio los barre el arranque.
///
/// Si no hay `ccode` —una build de desarrollo sin el binario al lado— se corre sin broker
/// en vez de fallar: el agente igual sirve, solo que sin poder pedir permiso.
fn write_mcp_config(app: &AppHandle, task_id: &str) -> Option<PathBuf> {
    crate::ipc::mcp::write_config(app, task_id, &["mcp", "--task", task_id])
}

/// Dónde va el NDJSON crudo de una tarea.
fn events_path_for(run_id: &str, task_id: &str) -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| "no se pudo resolver el home".to_string())?
        .join(".controlcode")
        .join("runs")
        .join(run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{task_id}.jsonl")))
}

/// Lo que un lanzamiento lleva además de la tarea, según el papel que cumple en su run.
#[derive(Default)]
pub struct LaunchExtras {
    /// El prompt a mandar, si no es el de la fila (un worker recibe el suyo más el contexto
    /// del run, que se arma al despacharlo y no se guarda).
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_tools: Vec<String>,
}

/// Arranca la tarea en segundo plano. Vuelve en cuanto el proceso quedó lanzado; lo que
/// pase después llega por eventos.
pub fn start(app: &AppHandle, task: Task, extras: LaunchExtras) -> Result<(), String> {
    // Se llama también desde afuera del runtime async: el hilo de una conexión del IPC (un
    // agente que despacha su plan) o un comando síncrono. Lanzar el proceso y la tarea que
    // lo espera necesita estar adentro de tokio.
    let runtime = tauri::async_runtime::handle();
    let _inside = runtime.inner().enter();
    let Some(adapter) = adapter_for(&task.agent_id) else {
        return Err(format!("todavía no se sabe correr '{}' sin terminal", task.agent_id));
    };

    let db = app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone();

    // El id de sesión lo decide la app ANTES de lanzar: así la fila ya sabe a qué sesión
    // mirar, y reabrir la tarea como tab con `--resume` no depende de descubrir nada.
    let session_id = Uuid::new_v4().to_string();
    let events_path = events_path_for(&task.run_id, &task.id)?;

    // La cuenta se resuelve justo antes de lanzar, no al crear la tarea: si dejó de
    // existir, se aborta en vez de caer a la cuenta del sistema — que es lo mismo que hace
    // el arranque de una tab (`Terminal.tsx`), y por el mismo motivo: correr con otra
    // cuenta que la pedida gasta cupo ajeno sin avisar.
    let account_env = match &task.account_id {
        Some(id) => crate::accounts::env_for_account(&db, id)
            .ok_or_else(|| format!("la cuenta '{id}' ya no existe"))?,
        None => Default::default(),
    };

    let mcp_config = write_mcp_config(app, &task.id);
    let ctx = LaunchCtx {
        session_id: &session_id,
        account_env,
        mcp_config: mcp_config.clone(),
        system_prompt: extras.system_prompt,
        allowed_tools: extras.allowed_tools,
        json_schema: task.result_schema.clone(),
    };
    let prompt = extras.prompt.unwrap_or_else(|| task.prompt.clone());
    let launch = adapter.launch(&prompt, task.model.as_deref(), task.budget_usd, &ctx);

    let mut command = tokio::process::Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&task.cwd)
        .envs(&launch.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Sin esto el hijo hereda el grupo de procesos de la app y un Ctrl-C en la
        // terminal que la lanzó se lo llevaría puesto a él también.
        .kill_on_drop(true);

    // El grupo se crea ANTES del spawn, para que exista cuando el hijo empiece a tener
    // descendencia propia: un agente que corre `cargo test` o levanta un server deja
    // nietos, y son los que quedarían huérfanos.
    let mut group = ProcessGroup::new(GROUP_SEQ.fetch_add(1, Ordering::Relaxed));

    let mut child = command.spawn().map_err(|e| {
        format!("no se pudo lanzar '{}': {e}", launch.program)
    })?;
    group.adopt(&child);
    live().insert(task.id.clone(), group);

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::mark_running(&conn, &task.id, &session_id, &events_path.to_string_lossy())?;
    }
    emit_changed(app, &task.id);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app = app.clone();
    let task_id = task.id.clone();
    let quota_key = super::quota::account_key(&task.agent_id, task.account_id.as_deref());

    tokio::spawn(async move {
        let mut file = tokio::fs::File::create(&events_path).await.ok();
        let mut emitted: Option<TaskOutcome> = None;

        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(f) = file.as_mut() {
                    let _ = f.write_all(line.as_bytes()).await;
                    let _ = f.write_all(b"\n").await;
                }
                for event in adapter.parse_line(&line) {
                    match event {
                        // Es de la cuenta, no de la tarjeta: se guarda para que el ruteo
                        // sepa cuánto le queda, y la consola no se entera.
                        AgentEvent::Quota { quota } => {
                            super::quota::record(&db, &quota_key, quota, crate::util::now_ts());
                        }
                        AgentEvent::Finished { ref outcome } => {
                            emitted = Some(outcome.clone());
                            emit_event(&app, &task_id, event);
                        }
                        event => emit_event(&app, &task_id, event),
                    }
                }
            }
        }

        // stderr se lee entero recién acá: no es el canal de eventos, pero es donde
        // aparece el motivo cuando el proceso muere sin llegar a emitir nada (un flag que
        // esta versión no acepta, una cuenta sin login).
        let stderr_text = match stderr {
            Some(mut e) => {
                let mut buf = Vec::new();
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut e, &mut buf).await;
                String::from_utf8_lossy(&buf).trim().to_string()
            }
            None => String::new(),
        };

        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        let mut outcome = adapter.finish(emitted, code);
        if !outcome.ok && outcome.error.is_none() && !stderr_text.is_empty() {
            outcome.error = Some(tail(&stderr_text, 400));
        }

        // Sacarlo del registro corre el `Drop` del grupo, que barre lo que el agente
        // hubiera dejado atrás (un `cargo test` a medias, un server levantado).
        live().remove(&task_id);
        // Un pedido de permiso sin proceso que lo espere no lo va a contestar nadie:
        // dejarlo en la cola lo mostraría en la consola para siempre.
        super::broker::drop_task(&task_id);
        if let Some(path) = &mcp_config {
            let _ = std::fs::remove_file(path);
        }

        if let Ok(conn) = db.lock() {
            let _ = store::finish_task(&conn, &task_id, &outcome);
        }
        emit_event(&app, &task_id, AgentEvent::Finished { outcome });
        emit_changed(&app, &task_id);
        // Lo que dependía de esta tarea puede arrancar (o no va a poder nunca).
        super::scheduler::on_task_finished(&app, &task_id);
    });

    Ok(())
}

/// Cancela una tarea en curso: marca la fila y mata el proceso con toda su descendencia.
pub fn cancel(app: &AppHandle, task_id: &str) -> Result<(), String> {
    stop(app, task_id, status::CANCELLED)
}

/// Para el proceso headless porque el usuario va a seguir la conversación en una terminal.
///
/// Hay que pararlo, no dejarlo correr en paralelo: dos procesos escribiendo la MISMA sesión
/// a la vez —el headless y el `--resume` de la tab— se pisarían el transcript, y el agente
/// de la tab arrancaría sin saber lo que el otro hizo después.
pub fn hand_off(app: &AppHandle, task_id: &str) -> Result<(), String> {
    stop(app, task_id, status::HANDED_OFF)
}

/// Marca la fila con `new_status` y mata el proceso con toda su descendencia.
///
/// El orden importa. La fila se marca PRIMERO: al morir el proceso, la tarea que lo espera
/// va a intentar cerrarlo como fallido, y `finish_task` solo pisa filas abiertas — así ni
/// una cancelación ni un traspaso a terminal se convierten en un error que no hubo.
fn stop(app: &AppHandle, task_id: &str, new_status: &str) -> Result<(), String> {
    let db = app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    // `ready` también: una tarea que se está lanzando todavía no llegó a `running`, y
    // pararla en ese instante no puede quedar sin efecto. Y `pending`: parar una que espera
    // turno es sacarla de la cola.
    conn.execute(
        "UPDATE tasks SET status = ?1, ended_at = ?2
         WHERE id = ?3 AND status IN ('pending', 'ready', 'running')",
        rusqlite::params![new_status, crate::util::now_ts(), task_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    super::broker::drop_task(task_id);
    if let Some(mut group) = live().remove(task_id) {
        group.kill_all();
    }
    emit_changed(app, task_id);
    // Una tarea parada libera su lugar y deja sin cumplir lo que dependía de ella.
    let run_id = db.lock().ok().and_then(|c| store::run_of_task(&c, task_id).ok().flatten()).map(|r| r.id);
    if let Some(run_id) = run_id {
        super::scheduler::tick(app, &run_id);
    }
    Ok(())
}

/// Las últimas `max` letras. El final de un stderr es donde está el error; el principio
/// suele ser ruido de arranque.
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    format!("…{}", s.chars().skip(n - max).collect::<String>())
}
