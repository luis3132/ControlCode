//! El arranque: qué comandos expone la app, qué hace en cada evento de ventana y qué
//! restaura al abrirse.

use tauri::{Emitter, Manager};

use crate::database::DbConnection;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_conn = crate::database::init_db().expect("Failed to initialize SQLite database");
    // Antes de construir Tauri, porque WebKitGTK decide cómo componer al inicializarse; y
    // antes del hilo de señales, porque toca el entorno del proceso (ver `configure`).
    super::rendering::configure(&db_conn);
    super::rendering::configure_scrollbars();
    // El PATH real del usuario, no el del escritorio: sin esto, en Ubuntu (y en macOS desde
    // el Dock) no se encontraban las TUIs instaladas en el home. Mismo requisito que el de
    // arriba: toca el entorno, así que va antes del primer hilo (ver `util::path_env`).
    crate::util::path_env::configure();
    super::signals::cleanup_on_signals();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db_conn)
        .invoke_handler(tauri::generate_handler![
            // Terminal embebida (PTY)
            crate::terminal::pty_create,
            crate::terminal::pty_attach,
            crate::terminal::pty_write,
            crate::terminal::pty_resize,
            crate::terminal::pty_kill,
            // Persistencia SQLite — workspaces (layouts guardados de ventanas/tabs)
            crate::database::db_list_workspaces,
            crate::database::db_save_workspace,
            crate::database::db_get_workspace_windows,
            crate::database::db_rename_workspace,
            crate::database::db_delete_workspace,
            crate::database::default_workspace_has_content,
            crate::database::db_list_session_history,
            // Workspaces cerrados a mano (v10)
            crate::database::save_workspace_snapshot,
            crate::database::list_workspace_snapshots,
            crate::database::take_workspace_snapshot,
            crate::database::forget_workspace_snapshot,
            crate::database::find_open_tab_for_session,
            // Persistencia SQLite — ventanas y tabs
            crate::database::db_save_window_state,
            crate::database::db_load_window_state,
            crate::database::db_mark_window_closed,
            // Continuidad de sesión real (resume) y títulos
            crate::session::discover_session_id,
            crate::session::get_session_title,
            // Gestión de ventanas
            crate::window::open_new_window,
            crate::window::broadcast_event,
            crate::window::get_home_dir,
            crate::window::open_workspace,
            crate::window::focus_window,
            crate::window::close_and_forget_window,
            crate::window::reset_default_workspace,
            crate::window::confirm_exit_all,
            // Explorador de archivos del workspace (panel derecho)
            crate::explorer::explorer_read_dir,
            crate::explorer::explorer_repo_info,
            crate::explorer::explorer_search,
            // Tabs de archivo
            crate::explorer::explorer_read_file,
            crate::explorer::explorer_write_file,
            crate::explorer::explorer_file_stat,
            // Control de versiones (panel derecho)
            crate::scm::scm_status,
            crate::scm::scm_init,
            crate::scm::scm_stage,
            crate::scm::scm_unstage,
            crate::scm::scm_discard,
            crate::scm::scm_commit,
            crate::scm::scm_branches,
            crate::scm::scm_checkout,
            crate::scm::scm_fetch,
            crate::scm::scm_pull,
            crate::scm::scm_push,
            crate::scm::scm_log,
            crate::scm::scm_file_at,
            // Tabs de navegador (proxy con selector de elementos)
            crate::preview::preview_resolve,
            crate::preview::preview_network,
            crate::preview::preview_set_recording,
            crate::preview::preview_request,
            crate::preview::preview_clear_network,
            crate::preview::preview_cookies,
            crate::preview::preview_forget_site,
            crate::preview::preview_detect_servers,
            crate::preview::preview_capture,
            crate::preview::preview_save_capture,
            crate::preview::preview_read_upload,
            crate::preview::preview_add_mock,
            crate::preview::preview_list_mocks,
            crate::preview::preview_clear_mocks,
            // Renderizado del WebView (texto nítido en Linux)
            crate::app::rendering_info,
            // Detección de agentes
            crate::agents::agent_registry,
            crate::agents::detect_agents,
            crate::agents::agent_search_path,
            // Agentes headless (consola de flota)
            crate::runs::run_list_tasks,
            crate::runs::run_list_runs,
            crate::runs::run_start_task,
            crate::runs::run_cancel_task,
            crate::runs::run_reroute_task,
            crate::runs::run_hand_off_task,
            crate::runs::run_discard_worktree,
            crate::runs::run_pending_approvals,
            crate::runs::run_decide_approval,
            crate::runs::run_list_rules,
            crate::runs::run_add_rule,
            crate::runs::run_delete_rule,
            crate::runs::run_roster,
            crate::runs::run_preview_route,
            crate::runs::run_get_tiers,
            crate::runs::run_set_tiers,
            // Cuentas múltiples por TUI
            crate::accounts::account_capable_agents,
            crate::accounts::list_agent_accounts,
            crate::accounts::create_agent_account,
            crate::accounts::delete_agent_account,
            crate::accounts::agent_account_env,
            crate::accounts::system_accounts,
            crate::usage::agent_account_usage,
            crate::usage::claude_live_usage,
            // Comandos previos al lanzamiento del agente (entornos aislados)
            crate::prelaunch::list_prelaunch_presets,
            crate::prelaunch::save_prelaunch_preset,
            crate::prelaunch::delete_prelaunch_preset,
            crate::prelaunch::resolve_prelaunch,
            // Settings genéricos (key-value)
            crate::database::db_get_setting,
            crate::database::db_set_setting,
            // Gestión de skills (symlinks globales)
            crate::skills::get_skills_dir,
            crate::skills::set_skills_dir,
            crate::skills::preview_skill_metadata,
            crate::skills::install_skill,
            crate::skills::create_skill,
            crate::skills::fork_skill,
            crate::skills::list_skills,
            crate::skills::get_skill_detail,
            crate::skills::update_skill_content,
            crate::skills::delete_skill,
            crate::skills::attach_skill,
            crate::skills::detach_skill,
            crate::skills::check_symlinks_health,
            crate::skills::sync_workspace_skills,
            crate::skills::reconcile_tab_skills,
            crate::skills::check_session_skills,
            crate::skills::restore_session_skills,
            crate::ipc::bridge::cli_respond,
            crate::ipc::mcp::tab_browser_mcp,
            crate::runs::run_start_orchestration,
            crate::runs::run_cancel_run,
            crate::runs::run_list_facts,
            crate::ipc::install::cli_install_status,
            crate::ipc::install::install_cli,
            crate::ipc::install::uninstall_cli,
            // Graphify: el grafo del proyecto, instalado paso a paso desde Configuración
            crate::graphify::graphify_plan,
            crate::graphify::graphify_install_command,
            crate::graphify::graphify_save_steps,
            crate::graphify::graphify_status,
            crate::graphify::graphify_run_step,
            crate::graphify::graphify_requirements,
            crate::graphify::graphify_commands,
            crate::graphify::graphify_render,
            crate::graphify::graphify_package_command,
            crate::database::db_delete_session_history,
            crate::session::session_markdown,
            crate::session::export_session_markdown,
            crate::agents::list_custom_agents,
            crate::agents::upsert_custom_agent,
            crate::agents::delete_custom_agent,
            crate::agents::import_legacy_custom_agents,
            // Marketplace de skills (registries remotos)
            crate::marketplace::list_registries,
            crate::marketplace::add_registry,
            crate::marketplace::preview_registry_location,
            crate::marketplace::rename_registry,
            crate::marketplace::remove_registry,
            crate::marketplace::set_registry_enabled,
            crate::marketplace::refresh_registry,
            crate::marketplace::list_marketplace_skills,
            crate::marketplace::search_remote_registries,
            crate::marketplace::install_marketplace_skill,
            crate::marketplace::marketplace_skill_readme,
            crate::skills::registry_skills,
            // Modo orquestador (Fase 9): consumo estimado y tabs observadas
            crate::orchestrator::orchestrator_stats,
            crate::orchestrator::orchestrator_reset_usage,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                let label = window.label().to_string();
                if let Some(db) = window.app_handle().try_state::<DbConnection>() {
                    let _ = crate::database::db_mark_window_closed(label, db);
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

            // Las cookies y el storage de cada sitio que se abre en el navegador de las tabs
            // se guardan acá (ver `preview/site.rs`): el motor del webview no los conserva.
            if let Ok(dir) = app.path().app_data_dir() {
                crate::preview::set_state_dir(dir.join("browser-state"));
            }

            // La skill de orquestación viaja con la app: se instala (o se actualiza) sola
            // antes de que haya ventanas, así la lista de skills ya la muestra al abrir.
            // Nunca falla el arranque — ver `crate::skills::bundled`.
            crate::skills::ensure_bundled_skills(app.handle(), &db);

            // Las tareas headless que quedaron `running` son de una ejecución anterior:
            // sus procesos eran hijos de la app y murieron con ella. Si no se cierran acá,
            // la consola las muestra trabajando para siempre.
            if let Ok(n) = crate::runs::sweep_orphans(&db) {
                if n > 0 {
                    eprintln!("[runs] {n} tarea(s) headless quedaron colgadas del cierre anterior");
                }
            }
            // Y sus pedidos de permiso: el agente que esperaba murió con la app, así que
            // no los va a contestar nadie.
            let _ = crate::runs::sweep_orphan_approvals(&db);
            // Los `--mcp-config` de tabs cerradas y tareas borradas: nadie los apunta ya.
            crate::ipc::mcp::sweep_configs(&db);

            let active_id = crate::database::db_get_last_active_workspace_id(&db)?;
            let windows = crate::database::db_get_all_workspace_windows(&active_id, &db)?;
            crate::window::restore_windows(app.handle(), windows, true)?;

            // Servidor IPC de la CLI `controlcode` (Fase 8). Va después de restaurar las
            // ventanas: varios comandos necesitan que exista al menos una para responder.
            crate::ipc::start(app.handle().clone());
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
                crate::ipc::cleanup();
                // Sin esto, cerrar la app deja corriendo lo que hayan lanzado los agentes
                // (servidores de desarrollo, watchers). El registry de PTYs es un
                // `lazy_static` y Rust no corre destructores de estáticos al salir, así
                // que el `Drop` que limpia cada grupo hay que dispararlo a mano.
                crate::terminal::kill_all_sessions();
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
