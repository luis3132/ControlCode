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
            // Persistencia SQLite — workspaces
            database::db_get_workspaces,
            database::db_create_workspace,
            database::db_touch_workspace,
            database::db_get_recent_workspaces,
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
            let db = app.state::<DbConnection>();
            let open_windows = database::db_get_open_window_labels(db)?;

            if let Some(main_state) = open_windows.iter().find(|w| w.label == "main") {
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

            let db_for_counts = app.state::<DbConnection>();
            for w in open_windows.iter().filter(|w| w.label != "main") {
                let tab_count = database::count_tabs_for_window(&db_for_counts, &w.id).unwrap_or(0);
                if tab_count == 0 {
                    continue;
                }

                let mut builder = tauri::WebviewWindowBuilder::new(
                    app,
                    &w.label,
                    tauri::WebviewUrl::App("/".into()),
                )
                .title(&w.label)
                .decorations(false);

                if let (Some(width), Some(height)) = (w.width, w.height) {
                    builder = builder.inner_size(width as f64, height as f64);
                } else {
                    builder = builder.inner_size(900.0, 650.0);
                }
                if let (Some(x), Some(y)) = (w.pos_x, w.pos_y) {
                    builder = builder.position(x as f64, y as f64);
                }

                builder.build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
