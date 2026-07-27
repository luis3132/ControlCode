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

/// Margen sobre `MAX_BUFFER_BYTES` que se deja acumular antes de recortar. `drain` es
/// O(tamaño del buffer) (memmove de todo lo que queda tras el hueco): sin este margen,
/// un proceso que escupe output sin parar (build, npm install) dispara ese memmove de
/// ~3MB en CADA chunk leído de 4KB una vez lleno el buffer. Recortando en lotes de
/// TRIM_MARGIN_BYTES en vez de byte a byte, el mismo trabajo se amortiza ~100x.
const TRIM_MARGIN_BYTES: usize = 512 * 1024;

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
    if buf.len() > MAX_BUFFER_BYTES + TRIM_MARGIN_BYTES {
        let excess = buf.len() - MAX_BUFFER_BYTES;
        buf.drain(0..excess);
    }
}

/// Crea un PTY, lanza el proceso dentro, y emite eventos `pty-data-{id}` al frontend.
///
/// `cols`/`rows` los manda el frontend ya medidos contra el tamaño real del contenedor
/// (`fitAddon.fit()`, ver Terminal.tsx) — antes se creaba fijo en 80x24 y recién se
/// resizeaba al tamaño real cuando disparaba el ResizeObserver, ya con el proceso vivo.
/// Muchas TUIs (agentes incluidos) leen el tamaño del terminal una sola vez al arrancar
/// y no vuelven a redibujar bien tras un `SIGWINCH` post-arranque — quedaban con
/// contenido cortado/desbordado hasta el primer redibujado manual. Con el tamaño correcto
/// desde el primer byte, ese problema no llega a existir.
#[tauri::command]
pub async fn pty_create(
    command: String,
    cwd: String,
    cols: u16,
    rows: u16,
    // `env`: variables extra a inyectar en el proceso — las declara la TUI custom que se
    // está lanzando (ver `agents::CustomAgent::env`). Se aplican DESPUÉS de las de la app,
    // así una TUI puede pisar `TERM`/`COLORTERM` si de verdad lo necesita.
    env: Option<std::collections::HashMap<String, String>>,
    app: AppHandle,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

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
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }

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

/// Scrollback acumulado de un PTY vivo, sin exigir que el llamador sea el frontend.
/// Lo usa el servidor IPC (`tab output` de la CLI); a diferencia de `pty_attach`, esto
/// no implica "conectarse" a la sesión, solo mirarla.
pub fn scrollback_of(id: u32) -> Option<String> {
    let buffers = PTY_BUFFERS.lock().ok()?;
    buffers.get(&id).map(|b| String::from_utf8_lossy(b).into_owned())
}

/// Escribe al PTY desde código Rust (servidor IPC). `pty_write` es la versión `async`
/// que expone el mismo comportamiento al frontend vía invoke.
pub fn write_to_pty(id: u32, data: &str) -> Result<(), String> {
    let mut registry = PTY_REGISTRY.lock().map_err(|e| e.to_string())?;
    let session = registry.get_mut(&id).ok_or_else(|| format!("PTY session {id} not found"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| format!("PTY write error: {e}"))?;
    session.writer.flush().map_err(|e| format!("PTY flush error: {e}"))
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
