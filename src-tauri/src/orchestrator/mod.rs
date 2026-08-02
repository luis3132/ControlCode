//! Fase 9 — Mitigación del consumo de contexto del modo orquestador.
//!
//! La Fase 8 dejó a un agente externo manejando la app por la CLI. El problema que abre es
//! que la CLI le devuelve texto de terminal, y el contexto de un modelo es finito: tres
//! tabs leídas un par de veces cada una ya lo llenan. Este módulo agrupa las tres piezas
//! que lo evitan:
//!
//! - [`digest`] — comprime la salida antes de devolverla (señales en vez de transcripción).
//! - [`watch`]  — modo push: las tabs avisan en vez de que el orquestador relea.
//! - [`cursors`](read_cursor) — cada lectura devuelve solo lo NUEVO, así que llamar dos
//!   veces seguidas no vuelve a cobrar lo mismo. Es el "contexto por invocación, no
//!   acumulativo" del plan.
//!
//! Y una cuarta transversal: [`record_response`] contabiliza lo que la CLI se llevó, para
//! que la app pueda mostrárselo al usuario. Sin ese número, el costo del modo orquestador
//! es invisible hasta que el modelo se queda sin contexto.

pub mod digest;
pub mod watch;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

/// Clave en la tabla `settings`. Compartida con el frontend (Ajustes → Orquestador).
pub const WATCH_LIMIT_KEY: &str = "orchestrator_watch_limit";
pub const DEFAULT_WATCH_LIMIT: usize = 3;

/// Evento que refresca el indicador de la UI. Se emite a todas las ventanas.
const STATS_EVENT: &str = "cc-orchestrator-stats";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Comandos de la CLI atendidos desde que arrancó la app.
    pub requests: u64,
    /// Bytes de JSON devueltos a la CLI.
    pub response_bytes: u64,
    /// Tokens estimados de esos bytes (ver `digest::estimate_tokens`).
    pub estimated_tokens: u64,
    pub last_command: Option<String>,
    pub last_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(flatten)]
    pub usage: Usage,
    /// Tabs bajo observación ahora mismo.
    pub watched: usize,
    pub watch_limit: usize,
}

lazy_static::lazy_static! {
    static ref USAGE: Mutex<Usage> = Mutex::new(Usage::default());
    /// Por tab: cuántos bytes de su salida ya se le entregaron al orquestador. Se guarda
    /// el total acumulado del PTY (monótono), no un offset dentro del buffer — el buffer
    /// se recorta por delante cuando crece, así que un offset absoluto se corrompería.
    static ref CURSORS: Mutex<HashMap<String, u64>> = Mutex::new(HashMap::new());
}

fn usage() -> MutexGuard<'static, Usage> {
    USAGE.lock().unwrap_or_else(|e| e.into_inner())
}

fn cursors() -> MutexGuard<'static, HashMap<String, u64>> {
    CURSORS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Límite de tabs observadas en simultáneo. Si el valor guardado no se puede leer o no es
/// un número, se cae al default en vez de fallar: quedarse sin límite sería peor que
/// ignorar una configuración rota.
pub fn watch_limit(db: &crate::database::DbConnection) -> usize {
    crate::database::get_setting(db, WATCH_LIMIT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_WATCH_LIMIT)
}

/// Contabiliza una respuesta ya serializada y avisa a la UI.
pub fn record_response(app: &AppHandle, command: &str, body: &str) {
    {
        let mut u = usage();
        u.requests += 1;
        u.response_bytes += body.len() as u64;
        u.estimated_tokens += digest::estimate_tokens(body);
        u.last_command = Some(command.to_string());
        u.last_at = Some(watch::now());
    }
    emit_stats(app);
}

pub fn emit_stats(app: &AppHandle) {
    let _ = app.emit(STATS_EVENT, stats_with_limit(0));
}

fn stats_with_limit(limit: usize) -> Stats {
    Stats {
        usage: usage().clone(),
        watched: watch::count(),
        // 0 = "no lo sé desde acá": el límite vive en SQLite y el emisor no siempre tiene
        // la conexión a mano. El frontend ya lo tiene leído de Ajustes.
        watch_limit: limit,
    }
}

/// Estado del modo orquestador. Lo pide la UI al montar; después se mantiene con el evento.
#[tauri::command]
pub fn orchestrator_stats(db: tauri::State<crate::database::DbConnection>) -> Result<Stats, String> {
    Ok(stats_with_limit(watch_limit(&db)))
}

/// Pone el contador en cero. Sirve para medir una tarea concreta ("¿cuánto costó esto?")
/// sin reiniciar la app.
#[tauri::command]
pub fn orchestrator_reset_usage(app: AppHandle) -> Result<(), String> {
    *usage() = Usage::default();
    emit_stats(&app);
    Ok(())
}

// ── Cursores de lectura ──────────────────────────────────────────

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Lo que hace que dos llamadas seguidas no cuesten dos veces lo mismo.
    #[test]
    fn a_second_read_only_returns_what_arrived_after_the_first() {
        forget_cursor("t1");

        let first = new_output_for("t1", "hola\n", 5);
        assert!(first.first_read);
        assert_eq!(first.text, "hola\n");

        let second = new_output_for("t1", "hola\nchau\n", 10);
        assert!(!second.first_read);
        assert_eq!(second.text, "chau\n");

        // Sin salida nueva, no se devuelve nada — el caso que antes reenviaba 200 líneas.
        let third = new_output_for("t1", "hola\nchau\n", 10);
        assert_eq!(third.text, "");
    }

    /// El buffer se recorta por delante al pasar de 3MB. Si mientras tanto se escribió más
    /// de lo que el buffer conserva, hay que decirlo en vez de devolver un pedazo cualquiera.
    #[test]
    fn output_lost_to_the_scrollback_trim_is_reported() {
        forget_cursor("t2");
        new_output_for("t2", "inicio", 6);

        // Se escribieron 1000 bytes más, pero el buffer solo conserva 10.
        let out = new_output_for("t2", "0123456789", 1006);
        assert!(out.lost);
        assert_eq!(out.text, "0123456789");
    }

    /// Reanudar una tab crea un PTY nuevo cuyo total arranca de cero. Con el cursor viejo,
    /// la resta daría negativo.
    #[test]
    fn a_restarted_pty_is_treated_as_a_first_read() {
        forget_cursor("t3");
        new_output_for("t3", "sesion vieja larga", 500);

        let out = new_output_for("t3", "sesion nueva", 12);
        assert!(out.first_read);
        assert_eq!(out.text, "sesion nueva");
    }

    /// El corte se hace por bytes: si cae en medio de un carácter multibyte, `&s[cut..]`
    /// paniquea. Un acento partido entre dos chunks es lo más común del mundo.
    #[test]
    fn cutting_inside_a_multibyte_character_does_not_panic() {
        forget_cursor("t4");
        new_output_for("t4", "ñ", 2);
        let out = new_output_for("t4", "ñañ", 5);
        assert!(out.text.ends_with("ñ"));
    }

    fn memory_db() -> crate::database::DbConnection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        std::sync::Arc::new(std::sync::Mutex::new(conn))
    }

    #[test]
    fn the_limit_falls_back_to_the_default_when_the_setting_is_garbage() {
        let db = memory_db();
        assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT);

        crate::database::set_setting(&db, WATCH_LIMIT_KEY, "no soy un numero").unwrap();
        assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT);

        crate::database::set_setting(&db, WATCH_LIMIT_KEY, "0").unwrap();
        assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT, "cero sería 'ninguna tab observable'");

        crate::database::set_setting(&db, WATCH_LIMIT_KEY, "5").unwrap();
        assert_eq!(watch_limit(&db), 5);
    }
}
