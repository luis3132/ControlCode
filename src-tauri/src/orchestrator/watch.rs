//! Modo push: en vez de que el orquestador relea tabs cada N segundos, las tabs avisan.
//!
//! El polling es la forma más cara de perder contexto: cada vuelta devuelve casi lo mismo
//! que la anterior, y el modelo paga por leerlo entero otra vez. Acá el backend mira el
//! stream del PTY (que ya está leyendo de todas formas) y emite un evento **solo** cuando
//! pasa algo que amerita mirar:
//!
//! - `error`  — apareció una línea clasificada como error.
//! - `exit`   — el proceso terminó, con su código de salida.
//! - `idle`   — dejó de escribir por N segundos después de haber escrito algo, que en una
//!   TUI interactiva significa "terminó" o "está esperando input".
//!
//! `idle` es el que reemplaza al polling de verdad: es la señal de "ya podés leer" que
//! antes el orquestador tenía que descubrir releyendo.
//!
//! El costo cuando nadie observa es una lectura atómica por chunk, así que la ruta normal
//! de la app (nadie usando la CLI) no paga nada.

use super::digest::{classify, visible_line, Severity};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, Once};
use std::time::Duration;

/// Cuántos segundos sin salida hacen falta para considerar que una tab quedó quieta.
pub const DEFAULT_IDLE_SECS: u64 = 20;

/// Un agente puede escupir cientos de líneas de error de un tirón (un stack, un build
/// roto). Se emite un solo evento por ventana de tiempo, con las primeras líneas.
const ERROR_COOLDOWN_SECS: i64 = 3;
const ERROR_LINES_PER_EVENT: usize = 3;

/// Tope de la cola. Si el orquestador no llama a `wait` durante mucho tiempo, se descartan
/// los eventos más viejos: los recientes son los que describen el estado actual.
const MAX_QUEUED_EVENTS: usize = 200;

/// Tope del fragmento de línea sin `\n` que se guarda entre chunks. Una TUI que dibuja
/// una pantalla completa sin saltos de línea no debe hacer crecer esto sin límite.
const MAX_PENDING_BYTES: usize = 16 * 1024;

const IDLE_TICK: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub tab_id: String,
    /// `error` | `exit` | `idle`
    pub kind: String,
    pub at: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

struct Watched {
    tab_id: String,
    idle_secs: u64,
    last_activity: i64,
    last_error_at: i64,
    saw_output: bool,
    idle_sent: bool,
    /// Resto de chunk sin `\n` todavía: los chunks del PTY cortan por tamaño de buffer,
    /// no por línea, y clasificar media línea da falsos negativos.
    pending: String,
}

lazy_static::lazy_static! {
    static ref WATCHED: Mutex<HashMap<u32, Watched>> = Mutex::new(HashMap::new());
    static ref QUEUE: Mutex<VecDeque<WatchEvent>> = Mutex::new(VecDeque::new());
    static ref QUEUE_CV: Condvar = Condvar::new();
}

/// Espejo del tamaño de `WATCHED` para que la ruta caliente (cada chunk de cada PTY de la
/// app) no tenga que tomar el mutex solo para descubrir que no hay nada que observar.
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static WATCHDOG: Once = Once::new();

fn watched() -> MutexGuard<'static, HashMap<u32, Watched>> {
    WATCHED.lock().unwrap_or_else(|e| e.into_inner())
}

fn queue() -> MutexGuard<'static, VecDeque<WatchEvent>> {
    QUEUE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn push_event(event: WatchEvent) {
    let mut q = queue();
    if q.len() >= MAX_QUEUED_EVENTS {
        q.pop_front();
    }
    q.push_back(event);
    QUEUE_CV.notify_all();
}

/// Empieza a observar una tab. Falla si ya se llegó al límite — ese límite es la
/// protección principal de la Fase 9: con más de un puñado de tabs vivas, la sola llegada
/// de eventos ya desborda el contexto del modelo.
pub fn add(pty_id: u32, tab_id: &str, idle_secs: u64, limit: usize) -> Result<(), String> {
    let mut map = watched();

    if let Some(existing) = map.values().find(|w| w.tab_id == tab_id) {
        // Reobservar la misma tab no debería contar contra el límite ni resetear nada
        // silenciosamente: se reporta como error explícito con el estado actual.
        let _ = existing;
        return Err(format!("La tab {tab_id} ya está siendo observada"));
    }
    if map.len() >= limit {
        return Err(format!(
            "Límite de tabs observadas alcanzado ({limit}). Soltá una con 'ccode watch remove --tab <id>' \
             o subí el límite en Ajustes → Orquestador."
        ));
    }

    map.insert(
        pty_id,
        Watched {
            tab_id: tab_id.to_string(),
            idle_secs,
            last_activity: now(),
            last_error_at: 0,
            saw_output: false,
            idle_sent: false,
            pending: String::new(),
        },
    );
    ACTIVE.store(map.len(), Ordering::Relaxed);
    drop(map);

    start_watchdog();
    Ok(())
}

pub fn remove_tab(tab_id: &str) -> bool {
    let mut map = watched();
    let key = map.iter().find(|(_, w)| w.tab_id == tab_id).map(|(k, _)| *k);
    match key {
        Some(k) => {
            map.remove(&k);
            ACTIVE.store(map.len(), Ordering::Relaxed);
            true
        }
        None => false,
    }
}

#[cfg(test)]
fn clear() {
    let mut map = watched();
    map.clear();
    ACTIVE.store(0, Ordering::Relaxed);
    queue().clear();
}

pub fn count() -> usize {
    ACTIVE.load(Ordering::Relaxed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedTab {
    pub tab_id: String,
    pub idle_secs: u64,
    /// Segundos desde la última vez que esta tab escribió algo.
    pub quiet_for: i64,
}

pub fn list() -> Vec<WatchedTab> {
    let now = now();
    let mut rows: Vec<WatchedTab> = watched()
        .values()
        .map(|w| WatchedTab {
            tab_id: w.tab_id.clone(),
            idle_secs: w.idle_secs,
            quiet_for: now - w.last_activity,
        })
        .collect();
    rows.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
    rows
}

/// Gancho desde el lector del PTY. Tiene que ser barato: corre por cada chunk de cada
/// terminal abierta de la app, esté o no siendo observada.
pub fn observe(pty_id: u32, chunk: &[u8]) {
    if ACTIVE.load(Ordering::Relaxed) == 0 {
        return;
    }
    let mut map = watched();
    let Some(w) = map.get_mut(&pty_id) else { return };

    let at = now();
    w.last_activity = at;
    w.saw_output = true;
    w.idle_sent = false;

    w.pending.push_str(&String::from_utf8_lossy(chunk));

    // Se procesan solo las líneas completas; el resto espera al próximo chunk.
    let Some(cut) = w.pending.rfind('\n') else {
        if w.pending.len() > MAX_PENDING_BYTES {
            w.pending.clear();
        }
        return;
    };
    let complete: String = w.pending.drain(..=cut).collect();

    if at - w.last_error_at < ERROR_COOLDOWN_SECS {
        return;
    }

    let errors: Vec<String> = complete
        .lines()
        .map(visible_line)
        .filter(|l| classify(l) == Some(Severity::Error))
        .take(ERROR_LINES_PER_EVENT)
        .collect();

    if errors.is_empty() {
        return;
    }
    w.last_error_at = at;
    let tab_id = w.tab_id.clone();
    drop(map);

    push_event(WatchEvent { tab_id, kind: "error".into(), at, lines: errors, exit_code: None });
}

/// El proceso de una tab observada terminó. Se avisa y se deja de observarla: seguir
/// contra un PTY muerto solo gastaría un slot del límite.
pub fn note_exit(pty_id: u32, code: i32) {
    if ACTIVE.load(Ordering::Relaxed) == 0 {
        return;
    }
    let mut map = watched();
    let Some(w) = map.remove(&pty_id) else { return };
    ACTIVE.store(map.len(), Ordering::Relaxed);
    drop(map);

    push_event(WatchEvent {
        tab_id: w.tab_id,
        kind: "exit".into(),
        at: now(),
        lines: Vec::new(),
        exit_code: Some(code),
    });
}

/// Devuelve los eventos pendientes; si no hay, espera hasta `timeout` a que llegue alguno.
///
/// Bloquear en vez de devolver vacío es lo que hace innecesario el polling: el orquestador
/// deja una llamada esperando y solo vuelve a gastar contexto cuando de verdad pasó algo.
pub fn wait(timeout: Duration, max: usize) -> Vec<WatchEvent> {
    let mut q = queue();
    if q.is_empty() {
        let (guard, _) = QUEUE_CV
            .wait_timeout(q, timeout)
            .unwrap_or_else(|e| e.into_inner());
        q = guard;
    }
    let take = max.min(q.len());
    q.drain(..take).collect()
}

/// Hilo que detecta el silencio. No hay forma de que el lector del PTY avise de que *no*
/// llegó nada, así que la única manera de detectar "quedó quieta" es mirar el reloj.
fn start_watchdog() {
    WATCHDOG.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(IDLE_TICK);
            if ACTIVE.load(Ordering::Relaxed) == 0 {
                continue;
            }
            let at = now();
            let mut due: Vec<String> = Vec::new();
            {
                let mut map = watched();
                for w in map.values_mut() {
                    if w.saw_output && !w.idle_sent && at - w.last_activity >= w.idle_secs as i64 {
                        w.idle_sent = true;
                        due.push(w.tab_id.clone());
                    }
                }
            }
            for tab_id in due {
                push_event(WatchEvent {
                    tab_id,
                    kind: "idle".into(),
                    at,
                    lines: Vec::new(),
                    exit_code: None,
                });
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Los tests comparten el registro global (es estado de proceso, como el de PTYs), así
    /// que corren en serie bajo este lock en vez de pisarse entre ellos.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn fresh() -> MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        guard
    }

    #[test]
    fn the_limit_is_what_stops_the_orchestrator_from_watching_everything() {
        let _g = fresh();
        assert!(add(1, "tab-a", DEFAULT_IDLE_SECS, 2).is_ok());
        assert!(add(2, "tab-b", DEFAULT_IDLE_SECS, 2).is_ok());

        let err = add(3, "tab-c", DEFAULT_IDLE_SECS, 2).unwrap_err();
        assert!(err.contains("Límite"), "el error tiene que explicar el límite: {err}");
        assert_eq!(count(), 2);

        // Soltar una libera el slot.
        assert!(remove_tab("tab-a"));
        assert!(add(3, "tab-c", DEFAULT_IDLE_SECS, 2).is_ok());
    }

    #[test]
    fn watching_the_same_tab_twice_is_rejected_instead_of_burning_a_slot() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
        assert!(add(9, "tab-a", DEFAULT_IDLE_SECS, 3).is_err());
        assert_eq!(count(), 1);
    }

    #[test]
    fn an_error_line_produces_an_event_and_normal_output_does_not() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

        observe(1, b"compilando...\ntodo bien\n");
        assert!(wait(Duration::from_millis(10), 10).is_empty());

        observe(1, b"ERROR: falta el modulo x\n");
        let events = wait(Duration::from_millis(10), 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "error");
        assert_eq!(events[0].tab_id, "tab-a");
        assert_eq!(events[0].lines, vec!["ERROR: falta el modulo x"]);
    }

    /// Un stack trace son cientos de líneas de error de golpe. Sin cooldown, cada una
    /// sería un evento y el orquestador recibiría justo la avalancha que esta fase evita.
    #[test]
    fn a_burst_of_errors_collapses_into_a_single_event() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

        for i in 0..50 {
            observe(1, format!("ERROR numero {i}\n").as_bytes());
        }
        let events = wait(Duration::from_millis(10), 100);
        assert_eq!(events.len(), 1);
        assert!(events[0].lines.len() <= ERROR_LINES_PER_EVENT);
    }

    /// El PTY corta por tamaño de buffer, no por línea: "ERR" y "OR: x\n" llegan separados
    /// y ninguno de los dos, por sí solo, parece un error.
    #[test]
    fn errors_split_across_chunks_are_still_detected() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

        observe(1, b"ERR");
        assert!(wait(Duration::from_millis(10), 10).is_empty());
        observe(1, b"OR: se rompio\n");

        let events = wait(Duration::from_millis(10), 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].lines, vec!["ERROR: se rompio"]);
    }

    #[test]
    fn ansi_colored_errors_are_detected_too() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
        observe(1, b"\x1b[31mError\x1b[0m: build roto\n");
        let events = wait(Duration::from_millis(10), 10);
        assert_eq!(events[0].lines, vec!["Error: build roto"]);
    }

    #[test]
    fn exit_emits_an_event_and_frees_the_slot() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
        note_exit(1, 130);

        let events = wait(Duration::from_millis(10), 10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "exit");
        assert_eq!(events[0].exit_code, Some(130));
        assert_eq!(count(), 0, "una tab muerta no debe seguir ocupando un slot");
    }

    #[test]
    fn nothing_is_observed_for_tabs_nobody_asked_about() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
        observe(7, b"ERROR: de otra tab\n");
        note_exit(7, 1);
        assert!(wait(Duration::from_millis(10), 10).is_empty());
    }

    /// `wait` con la cola vacía tiene que devolver vacío al vencer el timeout, no colgarse.
    #[test]
    fn waiting_with_nothing_to_report_times_out_empty() {
        let _g = fresh();
        let started = std::time::Instant::now();
        let events = wait(Duration::from_millis(50), 10);
        assert!(events.is_empty());
        assert!(started.elapsed() >= Duration::from_millis(45));
    }

    /// Los eventos se consumen: dos llamadas seguidas no devuelven lo mismo dos veces
    /// (que es exactamente el desperdicio de contexto que produce el polling).
    #[test]
    fn events_are_drained_once() {
        let _g = fresh();
        add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
        observe(1, b"ERROR: uno\n");

        assert_eq!(wait(Duration::from_millis(10), 10).len(), 1);
        assert!(wait(Duration::from_millis(10), 10).is_empty());
    }

    #[test]
    fn the_queue_drops_the_oldest_events_instead_of_growing_forever() {
        let _g = fresh();
        for i in 0..(MAX_QUEUED_EVENTS + 20) {
            push_event(WatchEvent {
                tab_id: format!("t{i}"),
                kind: "idle".into(),
                at: 0,
                lines: Vec::new(),
                exit_code: None,
            });
        }
        let events = wait(Duration::from_millis(10), 10_000);
        assert_eq!(events.len(), MAX_QUEUED_EVENTS);
        assert_eq!(events[0].tab_id, "t20", "se conservan los más recientes");
    }
}
