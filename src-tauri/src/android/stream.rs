//! La pantalla en video, directo de adb: `adb exec-out screenrecord --output-format=h264`.
//!
//! El encoder del teléfono manda cuadros solo cuando algo cambia, a 30–60 por segundo, con
//! ~100 ms de demora: nada que ver con un `screencap` en PNG por vez (más de un segundo por
//! cuadro en un teléfono real).
//!
//! El video no pasa por la IPC de Tauri. Un mensaje grande por un `Channel` termina en un
//! `webview.eval` en el hilo principal, y a 60 por segundo eso volvería a congelar la
//! interfaz. Se sirve por un socket local (`127.0.0.1`, con un token) que la vista lee con
//! `fetch`, en un hilo propio por conexión.
//!
//! Lo que viaja: mensajes `[largo u32][tipo u8][datos]`, con el largo contando el tipo.
//! - `0` configuración: `[largo u16][JSON][avcC]`, con `codec`, `width`, `height` (el video)
//!   y `deviceWidth`, `deviceHeight` (la pantalla, en la orientación actual).
//! - `1` cuadro: `[clave u8][NALs con su largo]`.
//! - `2` sigo acá: sin datos. Si escribirlo falla, la vista se fue y se corta.
//! - `3` error: texto. La vista vuelve a las capturas.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::adb;
use super::h264::{Splitter, Unit};

/// Cuánto tiene que estar quieto el pipe para dar por completo el último NAL. adb entrega un
/// cuadro en ráfagas separadas por menos de un milisegundo; con la pantalla quieta no llega
/// nada.
const IDLE: Duration = Duration::from_millis(20);
/// `screenrecord` corta solo a los 3 minutos; se vuelve a lanzar.
const TIME_LIMIT: u32 = 180;
/// El lado más largo del video, de mayor a menor: si el encoder no acepta uno, el siguiente.
const MAX_SIDES: [u32; 3] = [1600, 1280, 960];
const BIT_RATE: u32 = 8_000_000;
/// Cada cuánto se avisa "sigo acá" y se mira si la pantalla rotó.
const WATCH_EVERY: Duration = Duration::from_millis(1500);

struct Server {
    port: u16,
    token: String,
}

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);

fn server() -> Result<Arc<Server>, String> {
    let mut slot = SERVER.lock().map_err(|e| e.to_string())?;
    if let Some(server) = slot.as_ref() {
        return Ok(server.clone());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Could not open the screen stream: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = Arc::new(Server { port, token: uuid::Uuid::new_v4().simple().to_string() });
    let token = server.token.clone();
    std::thread::Builder::new()
        .name("android-stream".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let token = token.clone();
                let _ = std::thread::Builder::new().name("android-screen".into()).spawn(move || serve(conn, &token));
            }
        })
        .map_err(|e| e.to_string())?;
    *slot = Some(server.clone());
    Ok(server)
}

/// La dirección que la vista abre para ver `serial` en video.
pub fn url(serial: &str) -> Result<String, String> {
    let server = server()?;
    Ok(format!("http://127.0.0.1:{}/screen?token={}&serial={}", server.port, server.token, encode(serial)))
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lo que pide la vista: `GET /screen?token=…&serial=…`. Devuelve el serial.
pub fn parse_request(line: &str, token: &str) -> Option<String> {
    let path = line.strip_prefix("GET ")?.split(' ').next()?;
    let query = path.strip_prefix("/screen?")?;
    let mut serial = None;
    let mut ok = false;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("token", value)) => ok = value == token,
            Some(("serial", value)) => serial = Some(decode(value)),
            _ => {}
        }
    }
    serial.filter(|s| ok && !s.is_empty())
}

pub fn message(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.extend(((payload.len() + 1) as u32).to_be_bytes());
    out.push(kind);
    out.extend(payload);
    out
}

/// El tamaño de la pantalla en la orientación actual (`cur=` de `dumpsys window`), o el
/// físico si eso no está.
fn display_size(serial: &str) -> Option<(u32, u32)> {
    let text = adb::shell(
        serial,
        "dumpsys window displays 2>/dev/null | grep -m1 -o 'cur=[0-9]*x[0-9]*'; wm size",
        Duration::from_secs(5),
    )
    .ok()?;
    parse_display_size(&text)
}

pub fn parse_display_size(text: &str) -> Option<(u32, u32)> {
    let pair = |s: &str| {
        let (w, h) = s.trim().split_once('x')?;
        Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
    };
    let current = text.lines().find_map(|l| l.trim().strip_prefix("cur=").and_then(pair));
    let override_size = text.lines().find_map(|l| l.trim().strip_prefix("Override size:").and_then(pair));
    let physical = text.lines().find_map(|l| l.trim().strip_prefix("Physical size:").and_then(pair));
    current.or(override_size).or(physical)
}

/// El tamaño del video: la pantalla reducida hasta `max_side`, en múltiplos de 16 (lo que
/// mejor aceptan los encoders).
pub fn video_size((w, h): (u32, u32), max_side: u32) -> (u32, u32) {
    let scale = (f64::from(max_side) / f64::from(w.max(h))).min(1.0);
    let round = |v: u32| ((f64::from(v) * scale / 16.0).round() as u32).max(1) * 16;
    (round(w), round(h))
}

type Out = Arc<Mutex<TcpStream>>;

fn send(out: &Out, kind: u8, payload: &[u8]) -> bool {
    let Ok(mut stream) = out.lock() else { return false };
    stream.write_all(&message(kind, payload)).is_ok()
}

fn serve(conn: TcpStream, token: &str) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(reader) = conn.try_clone() else { return };
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    // El resto de la cabecera no importa, pero hay que leerla.
    let mut header = String::new();
    while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
        header.clear();
    }
    let mut conn = conn;
    let Some(serial) = parse_request(&line, token) else {
        let _ = conn.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\n\
                Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
    if conn.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = conn.set_nodelay(true);
    stream(&serial, Arc::new(Mutex::new(conn)));
}

/// El `screenrecord` que está corriendo, para cortarlo desde otro hilo.
type Running = Arc<Mutex<Option<Child>>>;

fn stop(running: &Running) {
    if let Some(mut child) = running.lock().ok().and_then(|mut c| c.take()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn stream(serial: &str, out: Out) {
    let closed = Arc::new(AtomicBool::new(false));
    let running: Running = Arc::new(Mutex::new(None));
    let size = Arc::new(Mutex::new((0u32, 0u32)));

    // Avisar "sigo acá" (así se sabe si la vista se fue aunque la pantalla esté quieta) y
    // relanzar el video si la pantalla rotó.
    {
        let (serial, out, closed, running, size) =
            (serial.to_string(), out.clone(), closed.clone(), running.clone(), size.clone());
        std::thread::spawn(move || {
            while !closed.load(Ordering::Relaxed) {
                std::thread::sleep(WATCH_EVERY);
                if !send(&out, 2, &[]) {
                    closed.store(true, Ordering::Relaxed);
                    stop(&running);
                    break;
                }
                let now = display_size(&serial);
                if now.is_some_and(|now| size.lock().is_ok_and(|s| *s != now && s.0 != 0)) {
                    stop(&running);
                }
            }
        });
    }

    let mut failures = 0usize;
    while !closed.load(Ordering::Relaxed) {
        let Some(device) = display_size(serial) else {
            send(&out, 3, b"The device is not answering.");
            break;
        };
        if let Ok(mut s) = size.lock() {
            *s = device;
        }
        let (width, height) = video_size(device, MAX_SIDES[failures.min(MAX_SIDES.len() - 1)]);
        let outcome = record(serial, device, (width, height), &out, &running, &closed);
        match outcome {
            Ok(()) => failures = 0,
            Err(why) => {
                failures += 1;
                if failures >= MAX_SIDES.len() {
                    send(&out, 3, why.as_bytes());
                    break;
                }
            }
        }
    }
    closed.store(true, Ordering::Relaxed);
    stop(&running);
}

/// Un `screenrecord`, hasta que termina, lo cortan o la vista se va. `Err` si no llegó a
/// mandar nada: el encoder no aceptó el tamaño o el dispositivo no lo tiene.
fn record(
    serial: &str,
    device: (u32, u32),
    (width, height): (u32, u32),
    out: &Out,
    running: &Running,
    closed: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut cmd = adb::command(Some(serial))?;
    cmd.args([
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        &format!("--size={width}x{height}"),
        &format!("--bit-rate={BIT_RATE}"),
        &format!("--time-limit={TIME_LIMIT}"),
        "-",
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run adb: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("adb gave no output")?;
    let mut stderr = child.stderr.take();
    if let Ok(mut slot) = running.lock() {
        *slot = Some(child);
    }
    let started = Instant::now();

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut split = Splitter::default();
    let mut configured = false;
    // Si nunca llega video, lo que se leyó es el error de `screenrecord`.
    let mut text = Vec::new();
    loop {
        let units = match rx.recv_timeout(IDLE) {
            Ok(bytes) => {
                if !configured && text.len() < 600 {
                    text.extend_from_slice(&bytes[..bytes.len().min(600)]);
                }
                split.push(&bytes)
            }
            Err(RecvTimeoutError::Timeout) => split.idle(),
            Err(RecvTimeoutError::Disconnected) => break,
        };
        for unit in units {
            let sent = match unit {
                Unit::Config { codec, avcc, width: w, height: h } => {
                    configured = true;
                    let (w, h) = if w == 0 || h == 0 { (width, height) } else { (w, h) };
                    let json = serde_json::json!({
                        "codec": codec, "width": w, "height": h,
                        "deviceWidth": device.0, "deviceHeight": device.1,
                    })
                    .to_string();
                    let mut payload = (json.len() as u16).to_be_bytes().to_vec();
                    payload.extend(json.as_bytes());
                    payload.extend(avcc);
                    send(out, 0, &payload)
                }
                Unit::Frame { key, data } => {
                    let mut payload = Vec::with_capacity(data.len() + 1);
                    payload.push(u8::from(key));
                    payload.extend(data);
                    send(out, 1, &payload)
                }
                // Un corte mal hecho: un `screenrecord` nuevo empieza con un cuadro clave.
                Unit::Broken => {
                    stop(running);
                    true
                }
            };
            if !sent {
                closed.store(true, Ordering::Relaxed);
                stop(running);
                return Ok(());
            }
        }
    }
    stop(running);
    if configured || closed.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut err = String::new();
    if let Some(stderr) = stderr.as_mut() {
        let _ = stderr.take(2000).read_to_string(&mut err);
    }
    let said = String::from_utf8_lossy(&text);
    let why = [err.trim(), said.trim()].into_iter().find(|s| !s.is_empty()).unwrap_or("screenrecord stopped");
    // Un encoder que no acepta el tamaño sale enseguida; uno que llegó a correr un rato y
    // terminó (el límite de tiempo, el teléfono bloqueado) no es una falla.
    if started.elapsed() > Duration::from_secs(5) {
        return Ok(());
    }
    Err(format!("The screen video could not start: {}", why.chars().take(300).collect::<String>()))
}
