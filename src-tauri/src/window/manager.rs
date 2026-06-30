use crate::database::{self, DbConnection, WindowRow};
use tauri::{AppHandle, Emitter, Manager};

/// Tamaño mínimo para toda ventana nueva (tear-off, restaurada, o por workspace).
/// Debe coincidir con `minWidth`/`minHeight` de la ventana "main" en tauri.conf.json.
const MIN_WINDOW_WIDTH: f64 = 900.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;

/// Recrea ventanas nativas a partir de filas guardadas en SQLite (posición, tamaño).
/// Usada tanto al arrancar la app (restaura todo lo que estaba `is_open = 1`) como al
/// abrir un workspace guardado en caliente desde la UI.
///
/// Si ya existe una ventana con label "main", se reposiciona la ventana default de Tauri
/// en vez de crear una nueva (Tauri ya la crea desde tauri.conf.json). Ventanas tear-off
/// sin tabs guardadas se omiten para no resucitar ventanas vacías.
pub fn restore_windows(app: &AppHandle, rows: Vec<WindowRow>) -> Result<(), String> {
    let db = app.state::<DbConnection>();

    if let Some(main_state) = rows.iter().find(|w| w.label == "main") {
        if let Some(main_win) = app.get_webview_window("main") {
            if let (Some(width), Some(height)) = (main_state.width, main_state.height) {
                let _ = main_win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                    width: width as u32,
                    height: height as u32,
                }));
            }
            if let (Some(x), Some(y)) = (main_state.pos_x, main_state.pos_y) {
                let _ = main_win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
            }
        }
    }

    for w in rows.iter().filter(|w| w.label != "main") {
        let tab_count = database::count_tabs_for_window(&db, &w.id).unwrap_or(0);
        if tab_count == 0 {
            continue;
        }

        let mut builder = tauri::WebviewWindowBuilder::new(app, &w.label, tauri::WebviewUrl::App("/".into()))
            .title(&w.label)
            .decorations(false)
            .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);

        if let (Some(width), Some(height)) = (w.width, w.height) {
            builder = builder.inner_size(
                (width as f64).max(MIN_WINDOW_WIDTH),
                (height as f64).max(MIN_WINDOW_HEIGHT),
            );
        } else {
            builder = builder.inner_size(900.0, 650.0);
        }
        if let (Some(x), Some(y)) = (w.pos_x, w.pos_y) {
            builder = builder.position(x as f64, y as f64);
        }

        builder.build().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Abre un workspace guardado: si `close_current` es true, cierra primero todas las
/// ventanas actualmente abiertas (su estado ya quedó persistido por el autosave normal);
/// luego recrea las ventanas del workspace elegido.
#[tauri::command]
pub async fn open_workspace(
    app: tauri::AppHandle,
    workspace_id: String,
    close_current: bool,
) -> Result<(), String> {
    if close_current {
        for (_, win) in app.webview_windows() {
            let _ = win.close();
        }
    }

    let db = app.state::<DbConnection>();
    let rows = database::db_get_workspace_windows(workspace_id, db)?;
    restore_windows(&app, rows)
}

/// Cierra la app entera ignorando el guardián de `ExitRequested` (llamado tras
/// confirmar "cerrar todo" en el diálogo de salida con varias ventanas abiertas).
///
/// OJO: `AppHandle::exit()` internamente llama a `request_exit()`, que vuelve a
/// disparar `RunEvent::ExitRequested` — con eso el guardián de lib.rs lo intercepta
/// de nuevo (sigue habiendo >1 ventana en el momento del request) y termina mostrando
/// el diálogo en otra ventana en vez de cerrar. Por eso acá se hace cleanup manual +
/// `std::process::exit`, salteando por completo el ciclo de eventos de Tauri.
#[tauri::command]
pub fn confirm_exit_all(app: tauri::AppHandle) {
    app.cleanup_before_exit();
    std::process::exit(0);
}

/// Abre una nueva ventana nativa de Tauri.
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Emite un evento a todas las ventanas abiertas (estado compartido entre ventanas).
#[tauri::command]
pub async fn broadcast_event(
    app: tauri::AppHandle,
    event: String,
    payload: String,
) -> Result<(), String> {
    app.emit(&event, payload).map_err(|e: tauri::Error| e.to_string())
}

/// Retorna los labels de todas las ventanas abiertas.
#[tauri::command]
pub fn get_window_labels(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows().into_keys().collect()
}

/// Retorna los bounds físicos (x, y, width, height) de cada ventana abierta.
/// Las coordenadas son en píxeles físicos (sin escalar), igual que screenX/Y * devicePixelRatio.
#[tauri::command]
pub fn get_all_window_bounds(
    app: tauri::AppHandle,
) -> std::collections::HashMap<String, (i32, i32, u32, u32)> {
    app.webview_windows()
        .iter()
        .filter_map(|(label, win)| {
            let pos = win.outer_position().ok()?;
            let size = win.outer_size().ok()?;
            Some((label.clone(), (pos.x, pos.y, size.width, size.height)))
        })
        .collect()
}

/// Retorna la posición del cursor en píxeles físicos (funciona en Wayland).
#[tauri::command]
pub fn get_cursor_position(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    app.cursor_position()
        .map(|p| (p.x, p.y))
        .map_err(|e| e.to_string())
}

/// Retorna el directorio home del usuario.
/// Necesario porque `process.env.HOME` no existe en el contexto browser de Tauri.
#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}
