mod agents;
mod database;
mod session;
mod terminal;
mod window;

use database::DbConnection;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_conn = database::init_db().expect("Failed to initialize SQLite database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db_conn)
        .invoke_handler(tauri::generate_handler![
            // Terminal embebida (PTY)
            terminal::pty_create,
            terminal::pty_attach,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            // Persistencia SQLite — workspaces (layouts guardados de ventanas/tabs)
            database::db_list_workspaces,
            database::db_save_workspace,
            database::db_get_workspace_windows,
            database::db_close_workspace_windows,
            database::db_rename_workspace,
            database::db_delete_workspace,
            database::db_get_workspace,
            database::default_workspace_has_content,
            database::db_get_window_workspace,
            // Persistencia SQLite — ventanas y tabs
            database::db_save_window_state,
            database::db_load_window_state,
            database::db_get_open_window_labels,
            database::db_mark_window_closed,
            // Sesiones tmux
            session::tmux_check,
            session::tmux_create_session,
            session::tmux_list_sessions,
            session::tmux_kill_session,
            // Continuidad de sesión real (resume) y títulos
            session::discover_session_id,
            session::get_session_title,
            // Gestión de ventanas
            window::open_new_window,
            window::broadcast_event,
            window::get_window_labels,
            window::get_all_window_bounds,
            window::get_cursor_position,
            window::get_home_dir,
            window::open_workspace,
            window::close_workspace_windows,
            window::reset_default_workspace,
            window::confirm_exit_all,
            // Detección de agentes
            agents::detect_agents,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let label = window.label().to_string();
                if let Some(db) = window.app_handle().try_state::<DbConnection>() {
                    let _ = database::db_mark_window_closed(label, db);
                }
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let _ = window.emit("cc-window-bounds-changed", ());
            }
            _ => {}
        })
        .setup(|app| {
            // Al arrancar, se restaura SOLO el workspace usado más recientemente (por
            // `last_active`, que se bumpea en cada autosave de ventana y al abrir un
            // workspace) — no todas las ventanas de todos los workspaces mezcladas.
            // Si nunca se creó/abrió un workspace nombrado, ese "más reciente" es
            // simplemente `default`, así que el comportamiento típico es el mismo.
            let db = app.state::<DbConnection>();
            let active_id = database::db_get_last_active_workspace_id(&db)?;
            let windows = database::db_get_all_workspace_windows(&active_id, &db)?;
            window::restore_windows(app.handle(), windows, true)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // A nivel de app (no por ventana individual, ver comentario en on_window_event):
            // si hay varias ventanas abiertas y se intenta salir de la app entera, se pausa
            // la salida y se le pregunta al frontend si quiere cerrar todo o solo la actual.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let window_count = app_handle.webview_windows().len();
                if window_count > 1 {
                    api.prevent_exit();
                    let _ = app_handle.emit("cc-app-exit-requested", window_count);
                }
            }
        });
}
