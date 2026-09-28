//! La salida de las tabs que un teléfono está mirando, en vivo.
//!
//! El lector del PTY (`terminal::pty_manager`) llama a [`on_pty_data`] con cada pedazo que
//! lee. Eso tiene que ser casi gratis cuando nadie mira —es el camino de TODA la salida de
//! todas las terminales—, así que sin suscriptores es una lectura atómica y vuelve.
//!
//! Con alguien mirando, lo que llega se junta y sale cada [`FLUSH_EVERY`] en un solo
//! mensaje por tab: un agente puede escribir cientos de pedazos por segundo, y mandarlos
//! de a uno sería cifrar y enviar cientos de mensajes (y chocar con el límite del relay).

use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const FLUSH_EVERY: Duration = Duration::from_millis(60);
/// Tope de un mensaje de salida. Cifrado y en base64 crece ~1.4×: queda lejos del tope
/// de frame del relay.
pub const MAX_CHUNK: usize = 64 * 1024;
/// Lo que se acumula como mucho entre dos envíos. Si el teléfono no da abasto se pierde lo
/// más viejo: lo que importa de una terminal es lo último.
const MAX_PENDING: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct Sub {
    device: String,
    tab_id: String,
}

lazy_static::lazy_static! {
    static ref SUBS: Mutex<HashMap<u32, Vec<Sub>>> = Mutex::new(HashMap::new());
    static ref PENDING: Mutex<HashMap<u32, Vec<u8>>> = Mutex::new(HashMap::new());
}

static ANY: AtomicBool = AtomicBool::new(false);

fn subs() -> std::sync::MutexGuard<'static, HashMap<u32, Vec<Sub>>> {
    SUBS.lock().unwrap_or_else(|e| e.into_inner())
}

fn pending() -> std::sync::MutexGuard<'static, HashMap<u32, Vec<u8>>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

fn refresh_any(all: &HashMap<u32, Vec<Sub>>) {
    ANY.store(!all.is_empty(), Ordering::Release);
}

pub fn subscribe(pty: u32, device: &str, tab_id: &str) {
    let mut all = subs();
    // Una tab la mira un teléfono una vez: engancharse de nuevo (volvió a la pantalla)
    // reemplaza a la anterior en vez de duplicar la salida.
    for list in all.values_mut() {
        list.retain(|s| !(s.device == device && s.tab_id == tab_id));
    }
    all.retain(|_, l| !l.is_empty());
    all.entry(pty).or_default().push(Sub { device: device.into(), tab_id: tab_id.into() });
    refresh_any(&all);
}

pub fn unsubscribe(device: &str, tab_id: Option<&str>) {
    let mut all = subs();
    for list in all.values_mut() {
        list.retain(|s| !(s.device == device && tab_id.is_none_or(|t| s.tab_id == t)));
    }
    all.retain(|_, l| !l.is_empty());
    let alive: Vec<u32> = all.keys().copied().collect();
    refresh_any(&all);
    drop(all);
    pending().retain(|pty, _| alive.contains(pty));
}

/// Todas las suscripciones: cuando se corta la conexión al relay nadie las va a leer.
pub fn clear() {
    let mut all = subs();
    all.clear();
    refresh_any(&all);
    drop(all);
    pending().clear();
}

pub fn on_pty_data(pty: u32, bytes: &[u8]) {
    if !ANY.load(Ordering::Acquire) || !subs().contains_key(&pty) {
        return;
    }
    let mut p = pending();
    let buf = p.entry(pty).or_default();
    buf.extend_from_slice(bytes);
    if buf.len() > MAX_PENDING {
        let excess = buf.len() - MAX_PENDING;
        buf.drain(..excess);
    }
}

pub fn on_pty_exit(pty: u32, code: i32) {
    if !ANY.load(Ordering::Acquire) {
        return;
    }
    flush();
    let gone = {
        let mut all = subs();
        let gone = all.remove(&pty).unwrap_or_default();
        refresh_any(&all);
        gone
    };
    for sub in gone {
        super::client::send_event(&sub.device, "tab.exit", json!({ "tabId": sub.tab_id, "code": code }));
    }
}

pub fn on_pty_resize(pty: u32, cols: u16, rows: u16) {
    if !ANY.load(Ordering::Acquire) {
        return;
    }
    // Lo que ya se escribió con el tamaño anterior sale antes del cambio.
    flush();
    let targets = subs().get(&pty).cloned().unwrap_or_default();
    for sub in targets {
        super::client::send_event(&sub.device, "tab.resize", json!({ "tabId": sub.tab_id, "cols": cols, "rows": rows }));
    }
}

/// Parte bytes en texto sin cortar un carácter por la mitad: lo que queda incompleto al
/// final vuelve para el próximo envío (el resto del carácter llega en la próxima lectura).
pub fn take_text(buf: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        // Incompleto al final: se guarda para después.
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        // Bytes inválidos en el medio (un programa que escribe binario): se reemplazan.
        Err(_) => buf.len(),
    };
    let rest = buf.split_off(cut);
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text
}

/// Corta un texto en pedazos de a lo sumo `max` bytes, sin partir caracteres.
pub fn chunks(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        out.push(&rest[..end]);
        rest = &rest[end..];
    }
    out
}

/// Manda lo acumulado. La llama la conexión cada [`FLUSH_EVERY`].
pub fn flush() {
    if !ANY.load(Ordering::Acquire) {
        return;
    }
    let ready: Vec<(u32, String)> = {
        let mut p = pending();
        p.iter_mut()
            .filter(|(_, buf)| !buf.is_empty())
            .map(|(pty, buf)| (*pty, take_text(buf)))
            .filter(|(_, text)| !text.is_empty())
            .collect()
    };
    if ready.is_empty() {
        return;
    }
    let all = subs().clone();
    for (pty, text) in ready {
        for sub in all.get(&pty).into_iter().flatten() {
            for piece in chunks(&text, MAX_CHUNK) {
                super::client::send_event(&sub.device, "tab.data", json!({ "tabId": sub.tab_id, "data": piece }));
            }
        }
    }
}
