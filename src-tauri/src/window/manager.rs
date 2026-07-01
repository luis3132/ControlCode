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
/// `reuse_main`: solo debe ser `true` en el arranque de la app, cuando Tauri ya creó la
/// ventana "main" desde `tauri.conf.json` y todavía no hay ninguna otra ventana viva — ahí
/// se reposiciona esa ventana en vez de crear una nueva. Si es `false` (abrir un workspace
/// en caliente mientras la app ya está corriendo), la fila con label "main" se trata como
/// cualquier otra: como ese label ya está ocupado por la ventana actual, se le asigna uno
/// nuevo antes de crear la ventana (ver más abajo) — si no, esa fila se saltaba por
/// completo y "mantener actuales" no abría nada.
///
/// En general, si el label guardado de una fila ya pertenece a una ventana nativa viva
/// (colisión), se renombra esa fila en SQLite a un label libre antes de construirla — el
/// label es único a nivel de proceso, y el frontend de la ventana nueva carga su estado
/// buscando por su propio label nativo, así que renombrar la fila es suficiente.
///
/// Ventanas tear-off sin tabs guardadas se omiten para no resucitar ventanas vacías.
pub fn restore_windows(app: &AppHandle, rows: Vec<WindowRow>, reuse_main: bool) -> Result<(), String> {
    let db = app.state::<DbConnection>();
    let live_labels: std::collections::HashSet<String> = app.webview_windows().into_keys().collect();

    for w in rows.iter() {
        if reuse_main && w.label == "main" {
            if let Some(main_win) = app.get_webview_window("main") {
                if let (Some(width), Some(height)) = (w.width, w.height) {
                    let _ = main_win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: width as u32,
                        height: height as u32,
                    }));
                }
                if let (Some(x), Some(y)) = (w.pos_x, w.pos_y) {
                    let _ = main_win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
                }
            }
            database::mark_window_open(&db, &w.id)?;
            continue;
        }

        let tab_count = database::count_tabs_for_window(&db, &w.id).unwrap_or(0);
        if tab_count == 0 {
            continue;
        }

        let mut label = w.label.clone();
        if live_labels.contains(&label) {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis();
            label = format!("cc-window-{millis}");
            database::rename_window_label(&db, &w.id, &label)?;
        }

        let mut builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("/".into()))
            .title(&label)
            .decorations(false)
            .transparent(true)
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
        database::mark_window_open(&db, &w.id)?;
    }

    Ok(())
}

/// Abre un workspace guardado. Si `close_current` es true, las ventanas que había
/// abiertas antes de esta llamada se cierran DESPUÉS de abrir las del workspace elegido
/// (no antes) — así la app nunca queda momentáneamente sin ninguna ventana viva, lo que
/// dispararía `RunEvent::ExitRequested` con cero ventanas y mataría el proceso entero
/// antes de que las nuevas llegaran a crearse. Su estado ya quedó persistido por el
/// autosave normal antes de cerrarlas.
///
/// `reuse_main` siempre es `false` acá (nunca es un arranque en frío): la ventana "main"
/// ya está en uso por la ventana actual, así que cualquier fila que la tenía como label
/// se renombra a uno libre dentro de `restore_windows`.
#[tauri::command]
pub async fn open_workspace(
    app: tauri::AppHandle,
    workspace_id: String,
    close_current: bool,
) -> Result<(), String> {
    let db = app.state::<DbConnection>();
    database::touch_workspace_now(&db, &workspace_id)?;
    let rows = database::db_get_all_workspace_windows(&workspace_id, &db)?;

    let previously_open: Vec<String> = if close_current {
        app.webview_windows().into_keys().collect()
    } else {
        Vec::new()
    };

    restore_windows(&app, rows, false)?;

    for label in previously_open {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }

    Ok(())
}

/// Cierra solo las ventanas (nativas) que pertenecen a `workspace_id` — usado por el
/// botón de cerrar del TopBar cuando hay más de una ventana en el workspace actual y el
/// usuario elige "cerrar todo". A diferencia de `confirm_exit_all`, esto NO mata el
/// proceso ni toca ventanas de otros workspaces que puedan estar abiertas a la vez (ej.
/// si se abrió otro workspace eligiendo "mantener actuales"). Cada `win.close()` dispara
/// el `WindowEvent::CloseRequested` normal, que ya persiste `is_open = 0` por su cuenta.
#[tauri::command]
pub async fn close_workspace_windows(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    let rows = database::db_get_workspace_windows(workspace_id, app.state::<DbConnection>())?;
    for w in &rows {
        if let Some(win) = app.get_webview_window(&w.label) {
            let _ = win.close();
        }
    }
    Ok(())
}

/// "Nuevo workspace" del TopBar: el bucket `default` (oculto, nunca se guarda con
/// nombre) se vacía por completo — cierra sus ventanas abiertas y borra sus filas
/// guardadas — y se abre una ventana nueva en blanco en ese mismo `default` recién
/// reseteado. Si el usuario quiere conservar lo que había, primero debe usar
/// "Guardar workspace" (que mueve esas ventanas a un workspace con id propio antes
/// de que esto las descarte).
#[tauri::command]
pub async fn reset_default_workspace(app: tauri::AppHandle) -> Result<(), String> {
    let default_id = database::DEFAULT_WORKSPACE_ID;

    let open_rows =
        database::db_get_workspace_windows(default_id.to_string(), app.state::<DbConnection>())?;
    for w in &open_rows {
        if let Some(win) = app.get_webview_window(&w.label) {
            let _ = win.close();
        }
    }

    let db = app.state::<DbConnection>();
    database::delete_workspace_windows(&db, default_id)?;
    database::touch_workspace_now(&db, default_id)?;

    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let label = format!("cc-window-{millis}");
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
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
        .transparent(true)
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
