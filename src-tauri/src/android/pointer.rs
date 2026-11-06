//! La entrada de la persona, por un `adb shell` que queda abierto.
//!
//! Lanzar `adb shell input …` por cada gesto obliga a esperar el gesto entero para mandarlo:
//! arrastrar se veía recién al soltar. Con un shell abierto, el dedo va en vivo:
//! `input motionevent DOWN`, después `MOVE` mientras se mueve el mouse y `UP` al soltar, como
//! un dedo de verdad. Mantener apretado es un toque largo porque el dedo está apoyado.
//!
//! Los gestos van en orden por una cola. Si el teléfono va más lento que el mouse, los
//! `MOVE` que esperan se juntan en el último: el dedo salta a donde está el mouse en vez de
//! repetir todo el recorrido atrasado.
//!
//! Android anterior a 10 no tiene `motionevent`: ahí el gesto se arma al soltar (toque,
//! toque largo o deslizamiento), como antes.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::adb;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Down,
    Move,
    Up,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Pointer(Phase, i32, i32),
    /// Un comando `input` ya armado (teclas, texto, la rueda del mouse).
    Command(String),
}

/// Qué hacer con un error del teléfono (la vista lo muestra).
pub type OnError = Arc<dyn Fn(String) + Send + Sync>;

/// Cuánto sigue abierto el shell sin que nadie toque nada.
const IDLE_CLOSE: Duration = Duration::from_secs(300);
/// Cuánto se espera a que el teléfono termine un comando.
const COMMAND_LIMIT: Duration = Duration::from_secs(10);
/// Lo que el shell imprime al terminar cada comando.
const DONE: &str = "__cc_done";
/// Menos que esto (en píxeles del dispositivo) es un toque y no un deslizamiento.
const SLOP: f64 = 24.0;
const HOLD_MS: u128 = 500;

struct Session {
    queue: Mutex<VecDeque<Op>>,
    wake: Condvar,
    alive: AtomicBool,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Agrega `op` a la cola de `serial`. No espera: los errores llegan por `on_error`.
pub fn send(serial: &str, op: Op, on_error: OnError) {
    let session = {
        let Ok(mut sessions) = SESSIONS.lock() else { return };
        match sessions.get(serial) {
            Some(s) if s.alive.load(Ordering::Relaxed) => s.clone(),
            _ => {
                let session =
                    Arc::new(Session { queue: Mutex::new(VecDeque::new()), wake: Condvar::new(), alive: AtomicBool::new(true) });
                sessions.insert(serial.to_string(), session.clone());
                let (serial, worker) = (serial.to_string(), session.clone());
                std::thread::spawn(move || run(&serial, &worker, &on_error));
                session
            }
        }
    };
    if let Ok(mut queue) = session.queue.lock() {
        enqueue(&mut queue, op);
    }
    session.wake.notify_one();
}

/// Un `MOVE` que espera detrás de otro lo reemplaza: importa dónde está el dedo ahora.
pub fn enqueue(queue: &mut VecDeque<Op>, op: Op) {
    if let (Op::Pointer(Phase::Move, ..), Some(Op::Pointer(Phase::Move, ..))) = (&op, queue.back()) {
        queue.pop_back();
    }
    queue.push_back(op);
}

/// Un gesto armado al soltar, para Android sin `motionevent`.
pub fn gesture_command(from: (i32, i32), to: (i32, i32), held: Duration) -> String {
    let distance = f64::from(to.0 - from.0).hypot(f64::from(to.1 - from.1));
    let ms = held.as_millis();
    if distance < SLOP {
        if ms >= HOLD_MS {
            format!("input swipe {} {} {} {} {}", from.0, from.1, from.0, from.1, ms.min(10_000))
        } else {
            format!("input tap {} {}", from.0, from.1)
        }
    } else {
        format!("input swipe {} {} {} {} {}", from.0, from.1, to.0, to.1, ms.clamp(80, 5000))
    }
}

fn run(serial: &str, session: &Arc<Session>, on_error: &OnError) {
    let mut child = None;
    if let Err(e) = serve(serial, session, on_error, &mut child) {
        on_error(e);
    }
    session.alive.store(false, Ordering::Relaxed);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Ok(mut sessions) = SESSIONS.lock()
        && sessions.get(serial).is_some_and(|s| Arc::ptr_eq(s, session))
    {
        sessions.remove(serial);
    }
}

/// Escribe un comando y espera su salida, hasta la marca de terminado.
fn exec(stdin: &mut ChildStdin, lines: &Receiver<String>, command: &str) -> Result<Vec<String>, String> {
    writeln!(stdin, "{command} 2>&1; echo {DONE}").map_err(|_| "The device disconnected.".to_string())?;
    stdin.flush().map_err(|_| "The device disconnected.".to_string())?;
    let deadline = Instant::now() + COMMAND_LIMIT;
    let mut out = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match lines.recv_timeout(left) {
            Ok(line) if line.trim() == DONE => return Ok(out),
            Ok(line) => out.push(line),
            Err(RecvTimeoutError::Timeout) => return Err("The device stopped answering.".into()),
            Err(RecvTimeoutError::Disconnected) => return Err("The device disconnected.".into()),
        }
    }
}

fn serve(serial: &str, session: &Session, on_error: &OnError, slot: &mut Option<Child>) -> Result<(), String> {
    let mut cmd = adb::command(Some(serial))?;
    cmd.arg("shell").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let child = slot.insert(cmd.spawn().map_err(|e| format!("Could not run adb: {e}"))?);
    let mut stdin = child.stdin.take().ok_or("adb gave no input")?;
    let stdout = child.stdout.take().ok_or("adb gave no output")?;
    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let motion = exec(&mut stdin, &lines, "input 2>&1 | grep -c motionevent")?
        .first()
        .and_then(|l| l.trim().parse::<u32>().ok())
        .is_some_and(|n| n > 0);
    // Sin `motionevent`: dónde y cuándo bajó el dedo.
    let mut pressed: Option<((i32, i32), Instant)> = None;

    loop {
        let op = {
            let mut queue = session.queue.lock().map_err(|e| e.to_string())?;
            loop {
                if let Some(op) = queue.pop_front() {
                    break op;
                }
                let (next, timeout) = session.wake.wait_timeout(queue, IDLE_CLOSE).map_err(|e| e.to_string())?;
                queue = next;
                if timeout.timed_out() && queue.is_empty() {
                    return Ok(());
                }
            }
        };
        let command = match op {
            Op::Command(command) => Some(command),
            Op::Pointer(phase, x, y) if motion => {
                let name = match phase {
                    Phase::Down => "DOWN",
                    Phase::Move => "MOVE",
                    Phase::Up => "UP",
                };
                Some(format!("input motionevent {name} {x} {y}"))
            }
            Op::Pointer(Phase::Down, x, y) => {
                pressed = Some(((x, y), Instant::now()));
                None
            }
            Op::Pointer(Phase::Move, ..) => None,
            Op::Pointer(Phase::Up, x, y) => pressed.take().map(|(from, at)| gesture_command(from, (x, y), at.elapsed())),
        };
        let Some(command) = command else { continue };
        let output = exec(&mut stdin, &lines, &command)?;
        let text = output.join("\n");
        if text.contains("Exception") || text.contains("Error:") || text.contains("INJECT_EVENTS") {
            let detail = output.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).take(2).collect::<Vec<_>>();
            on_error(adb::explain(detail.join(" ")));
        }
    }
}
