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
    // Mutable: los labels que se generan dentro del loop se van agregando, para que dos
    // filas restauradas en la misma pasada no puedan pisarse entre sí.
    let mut live_labels: std::collections::HashSet<String> =
        app.webview_windows().into_keys().collect();

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
            label = database::fresh_window_label();
            database::rename_window_label(&db, &w.id, &label)?;
        }
        live_labels.insert(label.clone());

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

        // Una ventana que no se puede construir no debe costarle al usuario el resto de su
        // layout: antes el `?` abortaba el loop entero y las filas que faltaban por
        // procesar no se restauraban ni quedaban marcadas como abiertas.
        match builder.build() {
            Ok(_) => database::mark_window_open(&db, &w.id)?,
            Err(e) => {
                eprintln!("[restore_windows] no se pudo recrear la ventana '{label}': {e}");
                live_labels.remove(&label);
            }
        }
    }

    // Con las ventanas ya marcadas como abiertas, sus tabs vuelven a "reclamar" sus
    // skills: se recrean los symlinks que se habían retirado al cerrarlas y se barren los
    // que hubiera dejado otro workspace en esas mismas carpetas. Cada tab lo re-verifica
    // igual antes de lanzar su proceso (`reconcile_tab_skills`), pero hacerlo acá es lo
    // que permite que el health check post-apertura no vea todo como "missing".
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        for w in rows.iter() {
            let dirs = crate::skills::link_dirs_of_window(&conn, &w.id);
            crate::skills::reconcile_link_dirs(&conn, &dirs);
        }
    }

    Ok(())
}

/// Crea una ventana nativa en blanco (sin tabs) para un workspace específico. Usado
/// cuando un workspace se queda sin ninguna ventana viva que mostrar: al cerrar la única
/// ventana que le quedaba (ver `close_and_forget_window`), o al intentar "abrir" un
/// workspace guardado cuyas filas están todas vacías o inexistentes (`restore_windows`
/// se salta a propósito las filas sin tabs, para no resucitar tear-offs vacíos — así que
/// si eso deja al workspace sin ninguna ventana recreada, hay que abrirle una en blanco).
fn spawn_blank_window(app: &AppHandle, db: &DbConnection, workspace_id: &str) -> Result<(), String> {
    let label = database::create_blank_window_row(db, workspace_id)?;
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = app.emit("cc-workspace-changed", ());
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

    // Si el workspace ya tiene ventanas nativas vivas, abrirlo otra vez crearía un segundo
    // juego de ventanas para el mismo layout guardado (sus labels colisionan con los vivos,
    // así que `restore_windows` renombra las filas y construye ventanas nuevas en paralelo
    // a las que ya estaban). El frontend evita eso llamando antes a `focusIfOpen`, pero esa
    // guarda vivía SOLO en la UI: `ccode workspace open` entraba directo acá y duplicaba.
    // Ahora la guarda es estructural — enfocar y salir es lo correcto para cualquier
    // llamador, y es idempotente para el flujo de la UI (que ya no llega hasta acá).
    // Se contrasta contra las ventanas NATIVAS, no contra `is_open` a secas: si la app se
    // cayó, las filas quedan en `is_open = 1` sin ninguna ventana real detrás, y confiar en
    // la columna haría que "abrir workspace" no hiciera nada visible.
    let already_live =
        database::db_get_workspace_windows(workspace_id.clone(), app.state::<DbConnection>())?;
    let live_window = already_live
        .iter()
        .find_map(|row| app.get_webview_window(&row.label));
    if let Some(win) = live_window {
        database::touch_workspace_now(&db, &workspace_id)?;
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

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

    // Si el workspace no tenía filas (0 ventanas guardadas) o todas sus filas eran
    // tear-offs vacíos que `restore_windows` se saltó, no quedó ninguna ventana viva
    // para este workspace pese a haberlo "abierto" — se le abre una en blanco en vez de
    // dejar al usuario sin nada visible.
    let live_now = database::db_get_workspace_windows(workspace_id.clone(), app.state::<DbConnection>())?;
    if live_now.is_empty() {
        spawn_blank_window(&app, &db, &workspace_id)?;
    }

    let _ = app.emit("cc-workspace-changed", ());
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
    let _ = app.emit("cc-workspace-changed", ());
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

    let label = database::fresh_window_label();
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;

    let _ = app.emit("cc-workspace-changed", ());
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

/// Cierra una única ventana que el usuario eligió cerrar explícitamente, dejando el resto
/// corriendo (botón de cerrar del TopBar, o "cerrar solo esta ventana" en cualquiera de
/// los diálogos de confirmación) — a diferencia de un cierre en bloque (todo un workspace,
/// cambiar de workspace, salir de la app entera), acá si el workspace todavía tiene otras
/// ventanas vivas la fila se borra de inmediato en vez de solo marcarse `is_open = 0`. Ver
/// `forget_or_close_single_window` para el detalle de esa decisión.
///
/// Cerrar acá NUNCA abre una ventana de reemplazo. Antes, si esta era la última ventana
/// viva de su workspace y quedaban ventanas de OTROS workspaces, se abría una en blanco
/// para que el workspace "no desapareciera de la vista". El efecto real era un bug muy
/// visible: con dos ventanas en dos workspaces distintos, cerrar una la hacía reaparecer
/// al instante (vacía) — el usuario no podía cerrarla.
///
/// La premisa era equivocada. Cerrar explícitamente la última ventana de un workspace no
/// pierde nada: la fila queda `is_open = 0` con sus tabs, el workspace sigue listado en
/// Workspaces y se reabre desde ahí. Que salga de la vista es exactamente lo pedido.
#[tauri::command]
pub async fn close_and_forget_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let db = app.state::<DbConnection>();
    database::forget_or_close_single_window(&db, &label)?;

    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }

    let _ = app.emit("cc-workspace-changed", ());
    Ok(())
}

/// Cuántas ventanas NATIVAS vivas tiene un workspace en este instante.
///
/// La fuente de verdad son las ventanas reales del proceso, no la columna `is_open`: esa
/// columna se escribe en el `CloseRequested`, así que va un paso por detrás durante un
/// cierre, y si la app se cae queda en `1` para ventanas que ya no existen. El botón de
/// cerrar del TopBar decide con este número si ofrece "cerrar todo el workspace" o cierra
/// esta ventana directamente, así que tiene que ser exacto.
///
/// Se cruzan las filas guardadas del workspace (sin filtrar por `is_open`, justamente para
/// no heredar su desincronización) con los labels nativos vivos.
#[tauri::command]
pub fn live_workspace_window_count(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<usize, String> {
    let db = app.state::<DbConnection>();
    let rows = database::db_get_all_workspace_windows(&workspace_id, &db)?;
    Ok(rows
        .iter()
        .filter(|r| app.get_webview_window(&r.label).is_some())
        .count())
}

/// Trae al frente una ventana nativa ya abierta (des-minimiza + foco). Usado cuando el
/// usuario intenta "abrir" un workspace que ya tiene ventanas vivas — en vez de crear
/// ventanas duplicadas para el mismo workspace (el caos que reportó el usuario: dos
/// juegos de ventanas para el mismo layout guardado), simplemente se enfoca la que ya
/// existe.
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.unminimize();
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
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
    // Las ventanas que ya estaban abiertas tienen que enterarse de que el workspace pasó a
    // tener una ventana más: es lo que hace que su botón de cerrar empiece a ofrecer
    // "cerrar todo el workspace" sin esperar a un refresco posterior.
    let _ = app.emit("cc-workspace-changed", ());
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
