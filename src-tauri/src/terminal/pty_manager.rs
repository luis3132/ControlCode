use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::Child + Send>,
}

type PtyRegistry = Arc<Mutex<HashMap<u32, PtySession>>>;
type PtyBuffers = Arc<Mutex<HashMap<u32, Vec<u8>>>>;

/// Tope del buffer de scrollback que se conserva por PTY, para poder reproducirlo
/// cuando una tab se mueve a otra ventana sin matar el proceso.
const MAX_BUFFER_BYTES: usize = 3 * 1024 * 1024;

lazy_static::lazy_static! {
    static ref PTY_REGISTRY: PtyRegistry = Arc::new(Mutex::new(HashMap::new()));
    static ref PTY_BUFFERS: PtyBuffers = Arc::new(Mutex::new(HashMap::new()));
    static ref PTY_COUNTER: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PtyDataPayload {
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PtyExitPayload {
    pub code: i32,
}

fn append_to_buffer(id: u32, chunk: &[u8]) {
    let mut buffers = PTY_BUFFERS.lock().unwrap();
    let buf = buffers.entry(id).or_default();
    buf.extend_from_slice(chunk);
    if buf.len() > MAX_BUFFER_BYTES {
        let excess = buf.len() - MAX_BUFFER_BYTES;
        buf.drain(0..excess);
    }
}

/// Crea un PTY, lanza el proceso dentro, y emite eventos `pty-data-{id}` al frontend.
#[tauri::command]
pub async fn pty_create(command: String, cwd: String, app: AppHandle) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut parts = command.split_whitespace();
    let program = parts.next().unwrap_or(&command);
    let mut cmd = CommandBuilder::new(program);
    for arg in parts {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn '{command}': {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = {
        let mut counter = PTY_COUNTER.lock().unwrap();
        *counter += 1;
        *counter
    };

    {
        let mut registry = PTY_REGISTRY.lock().unwrap();
        registry.insert(id, PtySession { master: pair.master, writer, killer: child });
    }
    PTY_BUFFERS.lock().unwrap().insert(id, Vec::new());

    let app_clone = app.clone();
    let event_name = format!("pty-data-{id}");
    let exit_event = format!("pty-exit-{id}");

    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    append_to_buffer(id, &buf[..n]);
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    app_clone.emit(&event_name, PtyDataPayload { data }).ok();
                }
                Err(_) => break,
            }
        }
        app_clone.emit(&exit_event, PtyExitPayload { code: 0 }).ok();
        PTY_REGISTRY.lock().unwrap().remove(&id);
        PTY_BUFFERS.lock().unwrap().remove(&id);
    });

    Ok(id)
}

/// Se "conecta" a un PTY que ya existe (p. ej. al mover una tab a otra ventana sin
/// matar el proceso) y devuelve el scrollback acumulado para reproducirlo en el xterm nuevo.
#[tauri::command]
pub fn pty_attach(id: u32) -> Result<String, String> {
    if !PTY_REGISTRY.lock().unwrap().contains_key(&id) {
        return Err(format!("PTY session {id} not found"));
    }
    let buffers = PTY_BUFFERS.lock().unwrap();
    Ok(buffers
        .get(&id)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default())
}

/// Escribe datos (input del usuario desde xterm.js) al PTY.
#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> Result<(), String> {
    let mut registry = PTY_REGISTRY.lock().unwrap();
    if let Some(session) = registry.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("PTY write error: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("PTY flush error: {e}"))?;
        Ok(())
    } else {
        Err(format!("PTY session {id} not found"))
    }
}

/// Redimensiona el PTY cuando cambia el tamaño de xterm.js.
#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let registry = PTY_REGISTRY.lock().unwrap();
    if let Some(session) = registry.get(&id) {
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Resize error: {e}"))
    } else {
        Err(format!("PTY session {id} not found"))
    }
}

/// Termina el proceso del PTY y limpia la sesión.
#[tauri::command]
pub async fn pty_kill(id: u32) -> Result<(), String> {
    if let Some(mut session) = PTY_REGISTRY.lock().unwrap().remove(&id) {
        session.killer.kill().map_err(|e| format!("Kill error: {e}"))?;
    }
    PTY_BUFFERS.lock().unwrap().remove(&id);
    Ok(())
}
