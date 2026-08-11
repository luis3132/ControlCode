mod accounts;
mod agents;
mod database;
pub mod ipc;
mod marketplace;
mod orchestrator;
mod prelaunch;
mod session;
mod skills;
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
            database::db_list_session_history,
            database::find_open_tab_for_session,
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
            window::focus_window,
            window::live_workspace_window_count,
            window::close_and_forget_window,
            window::reset_default_workspace,
            window::confirm_exit_all,
            // Detección de agentes
            agents::detect_agents,
            // Cuentas múltiples por TUI
            accounts::account_capable_agents,
            accounts::list_agent_accounts,
            accounts::create_agent_account,
            accounts::delete_agent_account,
            accounts::agent_account_env,
            // Comandos previos al lanzamiento del agente (entornos aislados)
            prelaunch::list_prelaunch_presets,
            prelaunch::save_prelaunch_preset,
            prelaunch::delete_prelaunch_preset,
            prelaunch::resolve_prelaunch,
            // Settings genéricos (key-value)
            database::db_get_setting,
            database::db_set_setting,
            // Gestión de skills (symlinks globales)
            skills::get_skills_dir,
            skills::set_skills_dir,
            skills::preview_skill_metadata,
            skills::install_skill,
            skills::list_skills,
            skills::list_skill_usage,
            skills::get_skill_detail,
            skills::update_skill_content,
            skills::delete_skill,
            skills::attach_skill,
            skills::detach_skill,
            skills::check_symlinks_health,
            skills::sync_workspace_skills,
            skills::reconcile_tab_skills,
            skills::check_session_skills,
            skills::restore_session_skills,
            ipc::bridge::cli_respond,
            ipc::install::cli_install_status,
            ipc::install::install_cli,
            ipc::install::uninstall_cli,
            database::db_delete_session_history,
            session::session_markdown,
            session::export_session_markdown,
            agents::list_custom_agents,
            agents::upsert_custom_agent,
            agents::delete_custom_agent,
            agents::import_legacy_custom_agents,
            // Marketplace de skills (registries remotos)
            marketplace::list_registries,
            marketplace::add_registry,
            marketplace::preview_registry_location,
            marketplace::rename_registry,
            marketplace::remove_registry,
            marketplace::set_registry_enabled,
            marketplace::reorder_registries,
            marketplace::refresh_registry,
            marketplace::list_marketplace_skills,
            marketplace::install_marketplace_skill,
            skills::registry_skills,
            // Modo orquestador (Fase 9): consumo estimado y tabs observadas
            orchestrator::orchestrator_stats,
            orchestrator::orchestrator_reset_usage,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let label = window.label().to_string();
                if let Some(db) = window.app_handle().try_state::<DbConnection>() {
                    let _ = database::db_mark_window_closed(label, db);
                }
                // Cualquier cierre de ventana cambia el conteo de ventanas/tabs de algún
                // workspace — se notifica a TODAS las ventanas (ej. el Home de otra
                // ventana) para que refresquen la lista en vez de quedar con datos viejos.
                let _ = window.app_handle().emit("cc-workspace-changed", ());
            }
            // `CloseRequested` NO alcanza para el conteo de ventanas vivas: en ese momento
            // la ventana todavía existe en `webview_windows()`, así que quien recalcule ahí
            // se cuenta a sí misma y ve una de más. `Destroyed` es el instante en que la
            // ventana realmente dejó de existir, y es el que hace que el botón de cerrar de
            // las otras ventanas deje de ofrecer "cerrar todo el workspace" en cuanto queda
            // una sola.
            tauri::WindowEvent::Destroyed => {
                let _ = window.app_handle().emit("cc-workspace-changed", ());
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

            // La skill de orquestación viaja con la app: se instala (o se actualiza) sola
            // antes de que haya ventanas, así la lista de skills ya la muestra al abrir.
            // Nunca falla el arranque — ver `skills::bundled`.
            skills::ensure_bundled_skills(app.handle(), &db);

            let active_id = database::db_get_last_active_workspace_id(&db)?;
            let windows = database::db_get_all_workspace_windows(&active_id, &db)?;
            window::restore_windows(app.handle(), windows, true)?;

            // Servidor IPC de la CLI `controlcode` (Fase 8). Va después de restaurar las
            // ventanas: varios comandos necesitan que exista al menos una para responder.
            ipc::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // A nivel de app (no por ventana individual, ver comentario en on_window_event):
            // si hay varias ventanas abiertas y se intenta salir de la app entera, se pausa
            // la salida y se le pregunta al frontend si quiere cerrar todo o solo la actual.
            if let tauri::RunEvent::Exit = event {
                // Sin esto quedaría un handshake apuntando a un puerto muerto, y la CLI
                // reportaría "no se pudo conectar" en vez de "la app no está corriendo".
                ipc::cleanup();
                // Sin esto, cerrar la app deja corriendo lo que hayan lanzado los agentes
                // (servidores de desarrollo, watchers). El registry de PTYs es un
                // `lazy_static` y Rust no corre destructores de estáticos al salir, así
                // que el `Drop` que limpia cada grupo hay que dispararlo a mano.
                terminal::kill_all_sessions();
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let window_count = app_handle.webview_windows().len();
                if window_count > 1 {
                    api.prevent_exit();
                    let _ = app_handle.emit("cc-app-exit-requested", window_count);
                }
            }
        });
}
