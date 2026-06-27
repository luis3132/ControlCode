mod database;
mod session;
mod terminal;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_conn = database::init_db().expect("Failed to initialize SQLite database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_conn)
        .invoke_handler(tauri::generate_handler![
            // Terminal embebida (PTY)
            terminal::pty_create,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            // Persistencia SQLite
            database::db_get_workspaces,
            database::db_create_workspace,
            // Sesiones tmux
            session::tmux_check,
            session::tmux_create_session,
            session::tmux_list_sessions,
            session::tmux_kill_session,
            // Gestión de ventanas
            window::open_new_window,
            window::broadcast_event,
            window::get_home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
