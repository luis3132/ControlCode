use super::containment::ProcessGroup;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::Child + Send>,
    /// Contenedor de ciclo de vida de la tab. Matar `killer` alcanza solo al proceso que
    /// lanzamos; esto se lleva además a toda su descendencia (ver `containment`).
    /// Su `Drop` mata el grupo, así que cubre tanto el cierre explícito como la muerte
    /// natural del proceso — los dos caminos por los que una sesión sale del registry.
    group: ProcessGroup,
}

/// Scrollback de un PTY. `total_bytes` cuenta TODO lo que el proceso escribió alguna vez,
/// incluido lo que ya se recortó de `data`: es lo que permite al orquestador saber cuánta
/// salida nueva hubo desde su última lectura sin depender de offsets dentro de un buffer
/// que se mueve (ver `orchestrator::new_output_for`).
#[derive(Default)]
struct PtyBuffer {
    data: Vec<u8>,
    total_bytes: u64,
}

type PtyRegistry = Arc<Mutex<HashMap<u32, PtySession>>>;
type PtyBuffers = Arc<Mutex<HashMap<u32, PtyBuffer>>>;

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

// Los tres mutex globales guardan colecciones que no quedan a medio escribir si un
// thread panica con el lock tomado (un `insert`/`remove` en un HashMap es atómico desde
// fuera), así que envenenar el mutex no significa que el dato sea inválido. Recuperarlo
// con `into_inner` en vez de `unwrap()` evita que un único panic aislado deje TODOS los
// terminales de la app muertos en cascada — que es justo lo que pasaría al propagar el
// panic desde cada comando `pty_*`.
fn registry() -> MutexGuard<'static, HashMap<u32, PtySession>> {
    PTY_REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn buffers() -> MutexGuard<'static, HashMap<u32, PtyBuffer>> {
    PTY_BUFFERS.lock().unwrap_or_else(|e| e.into_inner())
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
    let mut buffers = buffers();
    let buf = buffers.entry(id).or_default();
    buf.data.extend_from_slice(chunk);
    buf.total_bytes += chunk.len() as u64;
    if buf.data.len() > MAX_BUFFER_BYTES + TRIM_MARGIN_BYTES {
        let excess = buf.data.len() - MAX_BUFFER_BYTES;
        buf.data.drain(0..excess);
    }
}

/// Arma el script que ejecuta la cadena de pre-lanzamiento y termina en el agente.
///
/// El `exec` final es lo que hace que esto sea barato en unix: no lanza un hijo, sino que
/// REEMPLAZA la imagen del shell conservando su pid, sus descriptores y el entorno que los
/// pasos anteriores acaban de preparar. Así el pid que queda en el registry sigue siendo
/// el del agente, y `pty_kill`/`pty_resize` apuntan al proceso correcto.
///
/// El `&&` (y no `;`) es deliberado: si un paso falla, el agente NO arranca. Arrancar
/// fuera del entorno pedido es peor que no arrancar, y el error del shell queda escrito en
/// la terminal para que se vea qué pasó.
#[cfg(unix)]
pub(super) fn launch_script(command: &str, prelaunch: &[String]) -> String {
    format!("{} && exec {command}", prelaunch.join(" && "))
}

/// Windows no tiene `exec`: no hay forma de reemplazar la imagen de un proceso conservando
/// su pid. El agente queda sí o sí como hijo del `cmd` que lo lanza, y por eso matar la
/// tab tiene que llevarse al árbol entero — de eso se encarga el Job Object de
/// `containment`, sin el cual esta feature dejaría procesos huérfanos en cada cierre.
#[cfg(windows)]
pub(super) fn launch_script(command: &str, prelaunch: &[String]) -> String {
    format!("{} && {command}", prelaunch.join(" && "))
}

/// Parte un comando en programa + argumentos respetando comillas.
///
/// `split_whitespace` a secas rompía dos casos reales: una TUI custom instalada en una
/// ruta con espacios (`/home/u/mis tools/agente`) y cualquier flag con un valor
/// entrecomillado (`--system-prompt "hola mundo"`), que llegaba partido en pedazos.
/// No pretende ser un shell: resuelve comillas simples y dobles, que es lo que se escribe
/// en el campo de comando de un agente.
pub(super) fn split_command(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut actual = String::new();
    let mut abierta: Option<char> = None;
    let mut hubo_comillas = false;

    for c in command.chars() {
        match abierta {
            Some(q) if c == q => abierta = None,
            Some(_) => actual.push(c),
            None if c == '\'' || c == '"' => {
                abierta = Some(c);
                // `--flag=""` tiene que producir un argumento vacío, no ninguno.
                hubo_comillas = true;
            }
            None if c.is_whitespace() => {
                if !actual.is_empty() || hubo_comillas {
                    out.push(std::mem::take(&mut actual));
                    hubo_comillas = false;
                }
            }
            None => actual.push(c),
        }
    }
    if !actual.is_empty() || hubo_comillas {
        out.push(actual);
    }
    out
}

/// Arma el proceso a lanzar.
///
/// Sin pre-comandos devuelve exactamente lo de siempre: el binario con sus argumentos,
/// sin ningún intermediario. Con pre-comandos hay que delegar en un shell, porque
/// `conda activate` y compañía son funciones de shell y no programas: ejecutadas en un
/// proceso aparte, su efecto muere con él (ver el módulo `prelaunch`).
pub(super) fn build_launch(command: &str, prelaunch: &[String]) -> CommandBuilder {
    if prelaunch.is_empty() {
        let parts = split_command(command);
        let mut parts = parts.iter().map(String::as_str);
        let program = parts.next().unwrap_or(command);
        let mut cmd = CommandBuilder::new(program);
        for arg in parts {
            cmd.arg(arg);
        }
        return cmd;
    }

    shell_running(launch_script(command, prelaunch))
}

/// El shell que ejecuta el script.
///
/// `$SHELL` y no `bash` fijo: quien usa zsh o fish tiene su configuración ahí, y es de
/// donde salen las funciones que estos pasos suelen invocar.
///
/// `-l` (login) hace que se lean los perfiles del sistema y del usuario. Importa porque una
/// app lanzada desde el menú del escritorio no hereda el PATH de tu shell: sin esto, un
/// `nvm use` no tendría ni nvm que invocar.
#[cfg(unix)]
fn shell_running(script: String) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.arg("-c");
    cmd.arg(script);
    cmd
}

#[cfg(windows)]
fn shell_running(script: String) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("cmd");
    cmd.arg("/C");
    cmd.arg(script);
    cmd
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
    // `prelaunch`: comandos a ejecutar antes del agente, ya resueltos y en orden (ver el
    // módulo `prelaunch`). Vacío = se lanza igual que siempre, sin ningún intermediario.
    prelaunch: Option<Vec<String>>,
    app: AppHandle,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = build_launch(&command, &prelaunch.unwrap_or_default());
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let id = {
        let mut counter = PTY_COUNTER.lock().unwrap_or_else(|e| e.into_inner());
        *counter += 1;
        *counter
    };

    // El grupo se crea ANTES del spawn para que ya exista cuando el proceso empiece a
    // tener descendencia propia.
    let mut group = ProcessGroup::new(id);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn '{command}': {e}"))?;
    group.adopt(&*child);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    registry().insert(id, PtySession { master: pair.master, writer, killer: child, group });
    buffers().insert(id, PtyBuffer::default());

    let app_clone = app.clone();
    let event_name = format!("pty-data-{id}");
    let exit_event = format!("pty-exit-{id}");

    // `spawn_blocking` y no `spawn`: `reader.read()` es una lectura bloqueante sobre el fd
    // del PTY, y dentro de un `tokio::spawn` normal secuestra un worker del runtime durante
    // toda la vida del proceso. Con unas pocas terminales abiertas se agotan los workers y
    // el resto de tareas async de la app deja de progresar.
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    append_to_buffer(id, &buf[..n]);
                    // Modo push del orquestador (Fase 9): si nadie observa esta tab, esto
                    // es una lectura atómica y vuelve.
                    crate::orchestrator::watch::observe(id, &buf[..n]);
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    app_clone.emit(&event_name, PtyDataPayload { data }).ok();
                }
                Err(_) => break,
            }
        }
        // Se recoge el estado real del hijo antes de avisar al frontend. Sin este `wait`
        // el proceso queda además como zombie hasta que muere la app, porque nadie
        // reclama su status en el sistema.
        let code = registry()
            .remove(&id)
            .and_then(|mut session| session.killer.wait().ok())
            .map_or(0, |status| status.exit_code() as i32);
        crate::orchestrator::watch::note_exit(id, code);
        app_clone.emit(&exit_event, PtyExitPayload { code }).ok();
        buffers().remove(&id);
    });

    Ok(id)
}

/// Se "conecta" a un PTY que ya existe (p. ej. al mover una tab a otra ventana sin
/// matar el proceso) y devuelve el scrollback acumulado para reproducirlo en el xterm nuevo.
#[tauri::command]
pub fn pty_attach(id: u32) -> Result<String, String> {
    if !registry().contains_key(&id) {
        return Err(format!("PTY session {id} not found"));
    }
    let buffers = buffers();
    Ok(buffers
        .get(&id)
        .map(|b| String::from_utf8_lossy(&b.data).into_owned())
        .unwrap_or_default())
}

/// Scrollback acumulado de un PTY vivo, sin exigir que el llamador sea el frontend.
/// Lo usa el servidor IPC (`tab output` de la CLI); a diferencia de `pty_attach`, esto
/// no implica "conectarse" a la sesión, solo mirarla.
///
/// Devuelve además el total de bytes que el proceso escribió desde que arrancó, que
/// **no** es el largo del buffer: el buffer se recorta al llegar al tope. El orquestador
/// usa ese total como cursor para pedir solo lo nuevo.
/// Solo el total de bytes escritos, sin copiar el scrollback.
///
/// Lo usa la espera de "¿la TUI ya arrancó?" del `--initprompt`, que consulta cada 100ms:
/// con `scrollback_of` cada consulta clonaría megabytes para mirar un contador.
/// `None` = ese PTY ya no existe.
pub fn output_total(id: u32) -> Option<u64> {
    buffers().get(&id).map(|b| b.total_bytes)
}

pub fn scrollback_of(id: u32) -> Option<(String, u64)> {
    buffers()
        .get(&id)
        .map(|b| (String::from_utf8_lossy(&b.data).into_owned(), b.total_bytes))
}

/// Escribe al PTY desde código Rust (servidor IPC). `pty_write` es la versión `async`
/// que expone el mismo comportamiento al frontend vía invoke.
pub fn write_to_pty(id: u32, data: &str) -> Result<(), String> {
    let mut registry = registry();
    let session = registry.get_mut(&id).ok_or_else(|| format!("PTY session {id} not found"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| format!("PTY write error: {e}"))?;
    session.writer.flush().map_err(|e| format!("PTY flush error: {e}"))
}

/// Escribe datos (input del usuario desde xterm.js) al PTY.
#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> Result<(), String> {
    write_to_pty(id, &data)
}

/// Redimensiona el PTY cuando cambia el tamaño de xterm.js.
#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let registry = registry();
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
    if let Some(mut session) = registry().remove(&id) {
        // El grupo va PRIMERO: el respaldo por `ppid` de unix necesita al padre todavía
        // vivo para poder recorrer el árbol (una vez muerto, el kernel reasigna a los
        // hijos y se pierde el vínculo). Con cgroups o Job Objects el orden da igual.
        session.group.kill_all();
        session.killer.kill().map_err(|e| format!("Kill error: {e}"))?;
        // Se reclama el status para que el hijo no quede zombie: `kill` solo manda la
        // señal, no espera a que el proceso muera de verdad.
        let _ = session.killer.wait();
    }
    buffers().remove(&id);
    Ok(())
}

/// Mata todas las sesiones vivas y su descendencia. Se llama al salir de la app.
///
/// Hace falta explícitamente porque el registry es un `lazy_static`: Rust no corre
/// destructores de estáticos al terminar el proceso, así que sin esto el `Drop` de
/// `ProcessGroup` nunca se ejecutaría por esta vía.
///
/// En Windows hay además una segunda red que NO depende de que esto llegue a correr: el
/// job tiene `KILL_ON_JOB_CLOSE`, así que un cierre forzado desde el Administrador de
/// tareas igual se lleva todo cuando el kernel cierra los handles del proceso muerto.
pub fn kill_all_sessions() {
    let sessions: Vec<PtySession> = registry().drain().map(|(_, s)| s).collect();
    for mut session in sessions {
        session.group.kill_all();
        let _ = session.killer.kill();
        let _ = session.killer.wait();
    }
    buffers().clear();
}
