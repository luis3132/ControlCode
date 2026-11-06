//! Comandos que tocan la base o el disco, fuera del hilo principal.
//!
//! En Tauri 2 un comando síncrono (`pub fn`) corre en el hilo principal, que en Linux es
//! el mismo que dibuja la ventana: mientras espera el lock de la base (que otro hilo puede
//! tener tomado un buen rato) o recorre symlinks, la app entera se congela. La mayoría de
//! esos comandos ya son `async`; estos no pueden serlo porque otras partes del backend los
//! llaman directo, así que acá van versiones `async` con el mismo nombre que corren la
//! síncrona en un hilo de `spawn_blocking`. Son las que el frontend llama seguido.

use tauri::{AppHandle, Manager};

use crate::database::{DbConnection, WindowRow, WorkspaceSummary};
use crate::skills::{SkillWithUsage, SymlinkHealthEntry};

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(tauri::State<DbConnection>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(app.state::<DbConnection>()))
        .await
        .map_err(|e| e.to_string())?
}

/// Las ventanas nativas que existen ahora en este proceso.
///
/// `is_open` en la base no alcanza para decir qué está abierto: queda en 1 si la app se
/// cerró con "cerrar todo" (sale sin pasar por el cierre de cada ventana), si se la mató o
/// si una ventana no se pudo crear. Con eso un workspace figuraba abierto sin ninguna
/// ventana detrás, y elegirlo "enfocaba" una ventana que no existía: no pasaba nada y no
/// había forma de abrirlo.
fn live_labels(app: &AppHandle) -> std::collections::HashSet<String> {
    app.webview_windows().into_keys().collect()
}

/// Lo pide cada ventana cuando cambian los workspaces o las tabs de alguna.
#[tauri::command]
pub async fn db_list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceSummary>, String> {
    let live = live_labels(&app);
    blocking(app, move |db| {
        let mut workspaces = crate::database::db_list_workspaces(db.clone())?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        for ws in &mut workspaces {
            ws.open_window_count = crate::database::open_window_labels(&conn, &ws.id)?
                .iter()
                .filter(|label| live.contains(*label))
                .count() as i64;
        }
        Ok(workspaces)
    })
    .await
}

/// Las ventanas abiertas de un workspace: las que la base da por abiertas y además existen.
#[tauri::command]
pub async fn db_get_workspace_windows(app: AppHandle, workspace_id: String) -> Result<Vec<WindowRow>, String> {
    let live = live_labels(&app);
    let rows = blocking(app, move |db| crate::database::db_get_workspace_windows(workspace_id, db)).await?;
    Ok(rows.into_iter().filter(|row| live.contains(&row.label)).collect())
}

#[tauri::command]
pub async fn db_set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    blocking(app, move |db| crate::database::db_set_setting(key, value, db)).await
}

#[tauri::command]
pub async fn list_skills(app: AppHandle) -> Result<Vec<SkillWithUsage>, String> {
    blocking(app, crate::skills::list_skills).await
}

/// Cada terminal que arranca: recorre y rehace los symlinks de sus skills.
#[tauri::command]
pub async fn reconcile_tab_skills(app: AppHandle, tab_id: String) -> Result<(), String> {
    blocking(app, move |db| crate::skills::reconcile_tab_skills(tab_id, db)).await
}

#[tauri::command]
pub async fn attach_skill(
    app: AppHandle,
    skill_id: String,
    workspace_id: String,
    scope: String,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(app, move |db| crate::skills::attach_skill(skill_id, workspace_id, scope, tab_id, cwd, db)).await
}

#[tauri::command]
pub async fn detach_skill(
    app: AppHandle,
    skill_id: String,
    workspace_id: String,
    scope: String,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    blocking(app, move |db| crate::skills::detach_skill(skill_id, workspace_id, scope, tab_id, cwd, db)).await
}

#[tauri::command]
pub async fn check_symlinks_health(app: AppHandle, workspace_id: String) -> Result<Vec<SymlinkHealthEntry>, String> {
    blocking(app, move |db| crate::skills::check_symlinks_health(workspace_id, db)).await
}
