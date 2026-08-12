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

/// Limpieza cuando la app termina por una SEÑAL y no por su propio menú.
///
/// `RunEvent::Exit` solo dispara en un cierre normal. Un `kill`, cerrar la sesión del
/// escritorio o apagar el sistema mandan `SIGTERM`, y ahí Tauri no llega a correr nada
/// nuestro: los agentes —y todo lo que hayan lanzado— quedaban vivos. Medido con
/// `ccode` contra una app real antes de esto.
///
/// La limpieza NO puede correr dentro del handler: escribe archivos de cgroup y ejecuta
/// `ps`, y nada de eso es async-signal-safe. Se usa el truco del self-pipe — el handler
/// solo escribe un byte (una syscall `write`, que sí lo es) y despierta a un hilo normal
/// que hace el trabajo de verdad.
///
/// Se descartó la variante con `sigwait` + máscara bloqueada: **se probó y no funciona
/// acá**. La máscara se hereda al crear un hilo, pero GTK/WebKit levantan los suyos y
/// alguno queda con la señal desbloqueada, así que el kernel se la entrega a ese y se
/// aplica la acción por defecto (terminar) antes de que nadie limpie. Un handler es
/// process-wide y no depende de qué hilo la reciba.
///
/// Queda un caso fuera del alcance, y no hay forma de cubrirlo: `SIGKILL` no se puede
/// interceptar. En Windows no hace falta nada de esto, porque ahí limpia el kernel al
/// cerrar el handle del Job Object.
#[cfg(unix)]
fn cleanup_on_signals() {
    use std::sync::atomic::{AtomicI32, Ordering};

    static RECEIVED: AtomicI32 = AtomicI32::new(0);
    /// Extremo de escritura del self-pipe. `-1` = todavía sin instalar.
    static WAKE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(sig: libc::c_int) {
        // Lo único que pasa acá: dejar el número de señal y despertar al hilo. Un store
        // atómico y un `write` son de lo poco que se puede hacer sin riesgo desde un
        // handler.
        RECEIVED.store(sig, Ordering::SeqCst);
        let fd = WAKE_FD.load(Ordering::SeqCst);
        if fd >= 0 {
            unsafe { libc::write(fd, [1u8].as_ptr() as *const libc::c_void, 1) };
        }
    }

    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    WAKE_FD.store(write_fd, Ordering::SeqCst);

    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaction(sig, &action, std::ptr::null_mut());
        }
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 1];
        // Bloquea hasta que el handler escriba. Un `read` corto o interrumpido se reintenta
        // solo por el bucle.
        while unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) } <= 0 {}

        terminal::kill_all_sessions();
        ipc::cleanup();
        // Código de salida convencional para una muerte por señal, para que quien mandó el
        // kill vea lo que espera.
        std::process::exit(128 + RECEIVED.load(Ordering::SeqCst));
    });
}

#[cfg(not(unix))]
fn cleanup_on_signals() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_on_signals();
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
            marketplace::search_remote_registries,
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
