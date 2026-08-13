//! Cursores de lectura: cada lectura del orquestador devuelve solo lo NUEVO.
//!
//! Es lo que hace que llamar dos veces seguidas no vuelva a cobrar lo mismo — el
//! "contexto por invocación, no acumulativo" del plan.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

lazy_static::lazy_static! {
    /// Por tab: cuántos bytes de su salida ya se le entregaron al orquestador. Se guarda
    /// el total acumulado del PTY (monótono), no un offset dentro del buffer — el buffer
    /// se recorta por delante cuando crece, así que un offset absoluto se corrompería.
    static ref CURSORS: Mutex<HashMap<String, u64>> = Mutex::new(HashMap::new());
}

fn cursors() -> MutexGuard<'static, HashMap<String, u64>> {
    CURSORS.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct NewOutput {
    pub text: String,
    /// `true` si es la primera lectura de esta tab (no había cursor previo).
    pub first_read: bool,
    /// `true` si parte de lo no leído ya se había caído del buffer de scrollback.
    pub lost: bool,
}

/// Devuelve lo que la tab escribió DESDE la última lectura del orquestador.
///
/// `buffer` es el scrollback vivo y `total` el total de bytes que ese PTY escribió alguna
/// vez (el buffer se recorta, el total no). Con los dos se puede saber qué pedazo del
/// buffer es nuevo aunque el recorte se haya comido lo de más atrás.
pub fn new_output_for(tab_id: &str, buffer: &str, total: u64) -> NewOutput {
    let mut map = cursors();
    let seen = map.get(tab_id).copied();
    map.insert(tab_id.to_string(), total);
    drop(map);

    let Some(seen) = seen else {
        return NewOutput { text: buffer.to_string(), first_read: true, lost: false };
    };

    // El PTY se reinició (por ejemplo, la tab se reanudó): el total nuevo es menor que lo
    // que ya habíamos visto, así que el cursor viejo no significa nada.
    if total < seen {
        return NewOutput { text: buffer.to_string(), first_read: true, lost: false };
    }

    let new_bytes = (total - seen) as usize;
    let buffer_bytes = buffer.len();
    if new_bytes >= buffer_bytes {
        // Se escribió más de lo que el buffer conserva: lo que falta ya no existe.
        return NewOutput {
            text: buffer.to_string(),
            first_read: false,
            lost: new_bytes > buffer_bytes,
        };
    }

    // El corte tiene que caer en un límite de carácter UTF-8 o el slice paniquea.
    let mut cut = buffer_bytes - new_bytes;
    while cut < buffer_bytes && !buffer.is_char_boundary(cut) {
        cut += 1;
    }
    NewOutput { text: buffer[cut..].to_string(), first_read: false, lost: false }
}

/// Olvida el cursor de una tab (se cerró, o el usuario pidió releer desde el principio).
pub fn forget_cursor(tab_id: &str) {
    cursors().remove(tab_id);
}
