use tauri::{Emitter, Manager};

/// Abre una nueva ventana nativa de Tauri.
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
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
