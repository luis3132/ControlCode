//! Cerrar una ventana guardando antes, con la barra de progreso.
//!
//! El cierre que pide el sistema (Alt+F4, Cmd+Q, el gestor de ventanas) se frena acá y se
//! le avisa al frontend (`cc-close-requested`, con la etiqueta de la ventana): el frontend
//! guarda todo mostrando el progreso y después cierra de verdad, pidiendo paso con
//! [`allow`]. Los cierres que decide la propia app (cambiar de workspace, cerrar después de
//! guardar) piden paso igual y no se frenan.
//!
//! No se hace con `onCloseRequested` en JS: en Tauri 2 registrarlo deja el cierre nativo
//! colgado de lo que conteste el JS, y era justo lo que rompía el botón de cerrar.
//!
//! ## La salida de emergencia
//!
//! Si el frontend no contesta (colgado, a mitad de un error), la ventana no puede quedar
//! imposible de cerrar: un segundo pedido del sistema pasados [`STUCK_AFTER`] cierra sin
//! esperar.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub(crate) const STUCK_AFTER: Duration = Duration::from_secs(8);

#[derive(Default)]
struct Guard {
    /// Ventanas que la app va a cerrar ella misma: su próximo `CloseRequested` pasa.
    allowed: HashSet<String>,
    /// Ventanas guardando para cerrar, y desde cuándo.
    pending: HashMap<String, Instant>,
}

static GUARD: LazyLock<Mutex<Guard>> = LazyLock::new(|| Mutex::new(Guard::default()));

/// El próximo cierre de esta ventana no se frena: lo pidió la app.
pub(crate) fn allow(label: &str) {
    let mut g = GUARD.lock().unwrap();
    g.pending.remove(label);
    g.allowed.insert(label.to_string());
}

/// Qué hacer con un pedido de cierre del sistema.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Cerrar ya: lo pidió la app, o el guardado lleva demasiado.
    Close,
    /// Frenar y avisarle al frontend que guarde.
    Save,
    /// Ya está guardando: frenar y no volver a avisar.
    Wait,
}

pub(crate) fn decide(label: &str) -> Decision {
    decide_at(label, Instant::now())
}

fn decide_at(label: &str, now: Instant) -> Decision {
    let mut g = GUARD.lock().unwrap();
    if g.allowed.remove(label) {
        return Decision::Close;
    }
    match g.pending.get(label) {
        Some(since) if now.duration_since(*since) >= STUCK_AFTER => {
            g.pending.remove(label);
            Decision::Close
        }
        Some(_) => Decision::Wait,
        None => {
            g.pending.insert(label.to_string(), now);
            Decision::Save
        }
    }
}

/// Cierra una ventana sin frenarla.
pub(crate) fn close_now(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    allow(win.label());
    win.close()
}

/// Cierra la ventana que acaba de guardar. Deja la fila como cualquier cierre del sistema
/// (`is_open = 0` al pasar por `CloseRequested`), sin "olvidarla" como el botón de cerrar.
#[tauri::command]
pub fn close_window_saved(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;
    match app.get_webview_window(&label) {
        Some(win) => close_now(&win).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn el_sistema_se_frena_una_vez_y_la_app_pasa() {
        let now = Instant::now();
        assert_eq!(decide_at("w-a", now), Decision::Save);
        // Un segundo Alt+F4 enseguida no vuelve a abrir el guardado.
        assert_eq!(decide_at("w-a", now + Duration::from_secs(1)), Decision::Wait);
        // El cierre que pide la app después de guardar pasa.
        allow("w-a");
        assert_eq!(decide_at("w-a", now + Duration::from_secs(2)), Decision::Close);
        // Y la próxima vez vuelve a guardarse.
        assert_eq!(decide_at("w-a", now + Duration::from_secs(3)), Decision::Save);
    }

    #[test]
    fn un_guardado_colgado_no_deja_la_ventana_sin_poder_cerrarse() {
        let now = Instant::now();
        assert_eq!(decide_at("w-b", now), Decision::Save);
        assert_eq!(decide_at("w-b", now + STUCK_AFTER), Decision::Close);
    }
}
