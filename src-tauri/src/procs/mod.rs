//! Subprocesos: los procesos largos o pesados que lanzan los agentes (o la persona) y que
//! Control Code maneja por ellos — un servidor de desarrollo, un watcher, una compilación.
//!
//! Antes un agente los corría en su propia shell: en segundo plano, mezclados con su
//! salida, sin forma de verlos ni de pararlos desde afuera. Acá cada uno corre en su
//! propio PTY, con su árbol de procesos contenido (`ProcessGroup`), y la persona los ve en
//! la sección Subprocesos: sus logs en vivo, CPU y memoria, y puede escribirles, pararlos
//! o reiniciarlos. El agente los maneja con las tools `process_*` del MCP y lee sus logs
//! cuando los pide.
//!
//! - Viven en memoria: al cerrar la app mueren, como las terminales.
//! - Un PTY y no pipes: así una persona puede escribirles (un `y`, un Ctrl-C) y las
//!   herramientas que colorean o dibujan barras de progreso se comportan como en una
//!   terminal.
//! - Cada uno es de un workspace (la carpeta de la tab o del run que lo lanzó): el agente
//!   ve y maneja solo los suyos, la sección muestra los del workspace actual o todos.

mod commands;
mod logs;
mod stats;
#[cfg(test)]
mod test;

pub use commands::*;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// El evento que avisa que la lista cambió (uno nuevo, uno que terminó, uno reiniciado).
pub const CHANGED: &str = "cc-procs-changed";

/// Cuánto se le da a un proceso para irse con Ctrl-C antes de matarlo.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// El tamaño con que nace la terminal de un subproceso. Nadie la está mirando: cuando la
/// sección la abre, la ajusta a lo que mide.
const COLS: u16 = 120;
const ROWS: u16 = 32;

/// Cuántos subprocesos terminados se recuerdan como mucho. Los vivos no cuentan.
const KEEP_FINISHED: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Running,
    /// Terminó solo.
    Exited,
    /// Lo pararon (la persona o un agente).
    Stopped,
}

/// Quién lo lanzó.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    /// La tab del agente que lo pidió.
    pub tab_id: Option<String>,
    /// La tarea de la flota que lo pidió.
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subprocess {
    /// Corto y estable (`p3`): sobrevive a los reinicios, y es lo que escribe el agente.
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    /// La carpeta del workspace al que pertenece.
    pub workspace: String,
    pub owner: Owner,
    pub status: Status,
    pub exit_code: Option<i32>,
    /// El PTY donde corre ahora (cambia al reiniciar). La sección se conecta a él.
    pub pty_id: u32,
    /// Epoch en ms.
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub restarts: u32,
}

/// Lo que hace falta para lanzar uno.
#[derive(Debug, Clone)]
pub struct StartSpec {
    pub command: String,
    pub cwd: String,
    pub name: Option<String>,
    pub workspace: String,
    pub owner: Owner,
}

struct Registry {
    procs: Vec<Subprocess>,
    next: u32,
    /// Los que se están parando a pedido: su salida se registra como `Stopped`.
    stopping: Vec<String>,
}

/// Cómo se lanza un comando en un PTY (`pty_manager::spawn` con la app) y cómo se avisa
/// que la lista cambió. Se fijan al arrancar; los tests ponen los suyos con una app falsa.
type Spawner = Box<dyn Fn(&str, &str) -> Result<u32, String> + Send + Sync>;
type Notifier = Box<dyn Fn() + Send + Sync>;
static SPAWNER: OnceLock<Spawner> = OnceLock::new();
static NOTIFIER: OnceLock<Notifier> = OnceLock::new();

lazy_static::lazy_static! {
    static ref REGISTRY: Mutex<Registry> = Mutex::new(Registry { procs: Vec::new(), next: 1, stopping: Vec::new() });
}

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn notify() {
    if let Some(notify) = NOTIFIER.get() {
        notify();
    }
}

/// Se engancha al fin de cada PTY para marcar el estado de los subprocesos, haya o no una
/// ventana mirando. Se llama una vez, al arrancar la app.
pub fn init<R: tauri::Runtime>(app: &AppHandle<R>) {
    let (spawner, emitter) = (app.clone(), app.clone());
    install(
        Box::new(move |command, cwd| {
            crate::terminal::spawn(
                &spawner,
                crate::terminal::SpawnOptions {
                    label: command,
                    launch: crate::terminal::shell_launch(command),
                    cwd,
                    cols: COLS,
                    rows: ROWS,
                    env: HashMap::new(),
                },
            )
        }),
        Box::new(move || {
            let _ = emitter.emit(CHANGED, ());
        }),
    );
}

fn install(spawner: Spawner, notifier: Notifier) {
    if SPAWNER.set(spawner).is_err() {
        return;
    }
    let _ = NOTIFIER.set(notifier);
    crate::terminal::on_exit(note_exit);
}

/// Un PTY terminó: si era de un subproceso, queda registrado cómo.
pub(crate) fn note_exit(pty_id: u32, code: i32) {
    let changed = {
        let mut reg = registry();
        let Registry { procs, stopping, .. } = &mut *reg;
        match procs.iter_mut().find(|p| p.pty_id == pty_id && p.status == Status::Running) {
            Some(p) => {
                let stopped = stopping.iter().any(|id| *id == p.id);
                stopping.retain(|id| *id != p.id);
                p.status = if stopped { Status::Stopped } else { Status::Exited };
                // Matado a pedido, el código que llega no dice nada (el PTY ya no estaba).
                p.exit_code = if stopped { None } else { Some(code) };
                p.ended_at = Some(now_ms());
                true
            }
            None => false,
        }
    };
    if changed {
        notify();
    }
}

/// Un nombre para mostrar: el que se pidió, o el comando sin la ruta.
fn default_name(command: &str) -> String {
    let first: String = command.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
    if first.chars().count() > 40 { first.chars().take(40).collect::<String>() + "…" } else { first }
}

fn spawn_pty(command: &str, cwd: &str) -> Result<u32, String> {
    let spawn = SPAWNER.get().ok_or("la app todavía no terminó de arrancar")?;
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("{cwd} no es una carpeta"));
    }
    spawn(command, cwd)
}

/// Lanza un subproceso y lo registra.
pub fn start(spec: StartSpec) -> Result<Subprocess, String> {
    let command = spec.command.trim().to_string();
    if command.is_empty() {
        return Err("falta el comando".into());
    }
    let pty_id = spawn_pty(&command, &spec.cwd)?;
    let proc = {
        let mut reg = registry();
        let id = format!("p{}", reg.next);
        reg.next += 1;
        let proc = Subprocess {
            id,
            name: spec.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| default_name(&command)),
            command,
            cwd: spec.cwd,
            workspace: spec.workspace,
            owner: spec.owner,
            status: Status::Running,
            exit_code: None,
            pty_id,
            started_at: now_ms(),
            ended_at: None,
            restarts: 0,
        };
        reg.procs.push(proc.clone());
        forget_old(&mut reg);
        proc
    };
    notify();
    Ok(proc)
}

/// Los terminados más viejos se olvidan (y su salida se suelta) pasado el tope.
fn forget_old(reg: &mut Registry) {
    let finished: Vec<(String, u32)> =
        reg.procs.iter().filter(|p| p.status != Status::Running).map(|p| (p.id.clone(), p.pty_id)).collect();
    let excess = finished.len().saturating_sub(KEEP_FINISHED);
    for (id, pty) in finished.into_iter().take(excess) {
        reg.procs.retain(|p| p.id != id);
        crate::terminal::release(pty);
    }
}

pub fn get(id: &str) -> Option<Subprocess> {
    registry().procs.iter().find(|p| p.id == id).cloned()
}

/// Todos, o los de un workspace. Los vivos primero, y de ahí los más nuevos.
pub fn list(workspace: Option<&str>) -> Vec<Subprocess> {
    let mut out: Vec<Subprocess> = registry()
        .procs
        .iter()
        .filter(|p| workspace.is_none_or(|w| same_folder(&p.workspace, w)))
        .cloned()
        .collect();
    out.sort_by_key(|p| (p.status != Status::Running, std::cmp::Reverse(p.started_at)));
    out
}

/// Para. Sin `force`, primero un Ctrl-C (lo que haría una persona) y, si en unos segundos
/// no se fue, se lo mata con toda su descendencia. Bloquea hasta entonces.
pub fn stop(id: &str, force: bool) -> Result<Subprocess, String> {
    let proc = get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
    if proc.status != Status::Running {
        return Ok(proc);
    }
    registry().stopping.push(proc.id.clone());
    if !force && crate::terminal::write_to_pty(proc.pty_id, "\x03").is_ok() {
        let deadline = std::time::Instant::now() + STOP_GRACE;
        while std::time::Instant::now() < deadline && crate::terminal::is_running(proc.pty_id) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if crate::terminal::is_running(proc.pty_id) {
        crate::terminal::terminate(proc.pty_id)?;
    }
    // El aviso de fin lo marca `note_exit`, desde el hilo del PTY: se lo espera un poco
    // para devolver el estado final.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline && get(id).is_some_and(|p| p.status == Status::Running) {
        std::thread::sleep(Duration::from_millis(20));
    }
    get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))
}

/// Lo vuelve a lanzar, igual y en la misma carpeta. Si corría, primero lo para.
pub fn restart(id: &str) -> Result<Subprocess, String> {
    let proc = stop(id, false)?;
    let pty_id = spawn_pty(&proc.command, &proc.cwd)?;
    let updated = {
        let mut reg = registry();
        let p = reg.procs.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
        crate::terminal::release(p.pty_id);
        p.pty_id = pty_id;
        p.status = Status::Running;
        p.exit_code = None;
        p.started_at = now_ms();
        p.ended_at = None;
        p.restarts += 1;
        p.clone()
    };
    logs::forget_cursors(id);
    notify();
    Ok(updated)
}

/// Le escribe, como si alguien tipeara en su terminal. Con `enter`, confirma.
pub fn send(id: &str, text: &str, enter: bool) -> Result<(), String> {
    let proc = get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
    if proc.status != Status::Running {
        return Err(format!("{id} ya no está corriendo"));
    }
    crate::terminal::write_to_pty(proc.pty_id, text)?;
    if enter {
        // El Enter aparte, un momento después: igual que al escribirle a un agente, algunas
        // herramientas todavía están procesando el texto cuando llega.
        std::thread::sleep(Duration::from_millis(60));
        crate::terminal::write_to_pty(proc.pty_id, "\r")?;
    }
    Ok(())
}

/// Olvida los terminados (todos, o uno) y suelta su salida.
pub fn clear(id: Option<&str>) -> usize {
    let removed: Vec<u32> = {
        let mut reg = registry();
        let gone: Vec<(String, u32)> = reg
            .procs
            .iter()
            .filter(|p| p.status != Status::Running && id.is_none_or(|id| p.id == id))
            .map(|p| (p.id.clone(), p.pty_id))
            .collect();
        reg.procs.retain(|p| !gone.iter().any(|(id, _)| *id == p.id));
        gone.into_iter().map(|(_, pty)| pty).collect()
    };
    for pty in &removed {
        crate::terminal::release(*pty);
    }
    if !removed.is_empty() {
        notify();
    }
    removed.len()
}

/// Dos rutas de carpeta que son la misma, aunque una tenga barra final.
pub(crate) fn same_folder(a: &str, b: &str) -> bool {
    let trim = |s: &str| s.trim_end_matches(['/', '\\']).to_string();
    let (a, b) = (trim(a), trim(b));
    if cfg!(windows) { a.eq_ignore_ascii_case(&b) } else { a == b }
}

/// Solo para los tests: lanza con una app falsa (la de verdad no existe en un test).
#[cfg(test)]
pub(crate) fn init_for_tests() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let app = tauri::test::mock_app();
        init(app.handle());
        // La app falsa tiene que vivir lo que dure el proceso de tests.
        std::mem::forget(app);
    });
}
