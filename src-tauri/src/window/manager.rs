use tauri::Emitter;

/// Abre una nueva ventana nativa de Tauri.
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("/".into()))
        .title(&label)
        .inner_size(900.0, 650.0)
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

/// Retorna el directorio home del usuario.
/// Necesario porque `process.env.HOME` no existe en el contexto browser de Tauri.
#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}
