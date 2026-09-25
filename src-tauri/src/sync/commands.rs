//! Los comandos de la sincronización: configurarla (crear o conectar el repo en una cuenta),
//! sincronizar, ver cómo está y desconectarla.

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use super::export::export;
use super::import::{apply, load_pending};
use super::repo::{self, Push};
use super::tree::{merge3, Winner};
use crate::database::DbConnection;
use crate::forge::for_sync::{account_api, git_env_for_url, ForgeKind};
use crate::util::now_ts;

/// Una sola sincronización a la vez, aunque la pidan dos ventanas juntas.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub at: i64,
    /// Si se subió algo al repo.
    pub pushed: bool,
    /// Lo que cambió en esta máquina.
    pub changes: Vec<String>,
    /// Lo que cambiaron las dos máquinas a la vez; se quedó con la versión que ganó.
    pub conflicts: Vec<String>,
    /// Lo que no se pudo aplicar acá (queda pendiente para la próxima).
    pub failures: Vec<String>,
    /// Primera sincronización de esta máquina con ese repo.
    pub first: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub account_id: Option<String>,
    pub repo: Option<String>,
    pub web_url: Option<String>,
    pub auto: bool,
    pub last: Option<SyncReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub report: SyncReport,
    /// Las preferencias del webview ya mezcladas: el frontend las aplica.
    pub prefs: Map<String, Value>,
}

fn db(app: &AppHandle) -> Result<DbConnection, String> {
    app.try_state::<DbConnection>().map(|s| s.inner().clone()).ok_or_else(|| "La base de datos no está lista".into())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
}

fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn del(conn: &Connection, key: &str) {
    let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [key]);
}

fn status(conn: &Connection) -> SyncStatus {
    let repo = get(conn, "sync.repo");
    SyncStatus {
        configured: repo.is_some(),
        account_id: get(conn, "sync.account_id"),
        repo,
        web_url: get(conn, "sync.web_url"),
        auto: get(conn, "sync.auto").as_deref() != Some("0"),
        last: get(conn, "sync.last").and_then(|v| serde_json::from_str(&v).ok()),
    }
}

#[tauri::command]
pub fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    let db = db(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    Ok(status(&conn))
}

#[tauri::command]
pub fn sync_set_auto(app: AppHandle, auto: bool) -> Result<(), String> {
    let db = db(&app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    set(&conn, "sync.auto", if auto { "1" } else { "0" })
}

/// El nombre del repo, como lo aceptan GitHub, GitLab y Gitea.
fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['.', '-'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Configura la sincronización en una cuenta: usa el repo `nombre` de esa cuenta si ya
/// existe (otra máquina lo creó) o lo crea PRIVADO. Un repo que existe y es público se
/// rechaza: ahí van las skills y la configuración del usuario.
#[tauri::command]
pub async fn sync_setup(app: AppHandle, account_id: String, name: String) -> Result<SyncStatus, String> {
    let _guard = LOCK.lock().await;
    let name = name.trim().to_string();
    if !valid_repo_name(&name) {
        return Err(format!("«{name}» no es un nombre de repositorio válido"));
    }
    let (account, api) = account_api(&app, &account_id).await.map_err(|e| e.to_string())?;
    if account.kind == ForgeKind::Other {
        return Err("Una cuenta genérica no puede crear repositorios: elegí una de GitHub, GitLab o Gitea".into());
    }
    let full = format!("{}/{}", account.login, name);
    let repo = match api.find_repo(&full).await.map_err(|e| e.to_string())? {
        Some(existing) if !existing.private => {
            return Err(format!("{full} ya existe y es público: elegí otro nombre (acá van tus skills y tu configuración)"))
        }
        Some(existing) => existing,
        None => api
            .create_private_repo(&name, "Control Code sync: skills and settings")
            .await
            .map_err(|e| e.to_string())?,
    };
    let env = git_env_for_url(&app, &repo.clone_url, Some(&account_id)).await.map_err(|e| e.to_string())?;
    let parent = data_dir(&app)?.join("sync");
    let url = repo.clone_url.clone();
    tauri::async_runtime::spawn_blocking(move || repo::clone(&parent, &url, &env))
        .await
        .map_err(|e| e.to_string())??;

    let conn = db(&app)?;
    let conn = conn.lock().map_err(|e| e.to_string())?;
    set(&conn, "sync.account_id", &account_id)?;
    set(&conn, "sync.repo", &repo.full_name)?;
    set(&conn, "sync.url", &repo.clone_url)?;
    set(&conn, "sync.web_url", &repo.web_url)?;
    for key in ["sync.base", "sync.pending", "sync.last"] {
        del(&conn, key);
    }
    Ok(status(&conn))
}

/// Deja de sincronizar. El repo queda como está en la cuenta; el clon local se borra.
#[tauri::command]
pub async fn sync_disconnect(app: AppHandle) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    {
        let conn = db(&app)?;
        let conn = conn.lock().map_err(|e| e.to_string())?;
        for key in ["sync.account_id", "sync.repo", "sync.url", "sync.web_url", "sync.base", "sync.pending", "sync.last"] {
            del(&conn, key);
        }
    }
    let _ = std::fs::remove_dir_all(data_dir(&app)?.join("sync"));
    Ok(())
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "another machine".into())
}

/// Sincroniza: trae el repo, mezcla con esta máquina, sube el resultado y aplica acá lo que
/// llegó. `prefs` son las preferencias del webview (idioma, tema…), que solo conoce el
/// frontend; vuelven mezcladas en el resultado.
#[tauri::command]
pub async fn sync_now(app: AppHandle, prefs: Map<String, Value>) -> Result<SyncResult, String> {
    let _guard = LOCK.lock().await;
    let db = db(&app)?;
    let data = data_dir(&app)?;
    let dir = repo::repo_dir(&data);
    let (account_id, url, base_rev, pending) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let (Some(account), Some(url)) = (get(&conn, "sync.account_id"), get(&conn, "sync.url")) else {
            return Err("La sincronización no está configurada".into());
        };
        (account, url, get(&conn, "sync.base"), load_pending(&conn))
    };
    let env = git_env_for_url(&app, &url, Some(&account_id)).await.map_err(|e| e.to_string())?;

    // El clon puede no estar (se borró la carpeta de datos): se vuelve a hacer.
    if !dir.join(".git").exists() {
        let (parent, url, env) = (data.join("sync"), url.clone(), env.clone());
        tauri::async_runtime::spawn_blocking(move || repo::clone(&parent, &url, &env))
            .await
            .map_err(|e| e.to_string())??;
    }

    let mut report = SyncReport { at: now_ts(), ..Default::default() };
    let mut outcome = None;
    // Si otra máquina sube en el medio, se vuelve a mezclar. Tres intentos alcanzan.
    for _ in 0..3 {
        let (dir2, env2, base_rev2, pending2, prefs2, db2) =
            (dir.clone(), env.clone(), base_rev.clone(), pending.clone(), prefs.clone(), db.clone());
        let step = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            repo::fetch(&dir2, &env2)?;
            let remote_rev = repo::remote_head(&dir2);
            let base_rev = base_rev2.filter(|r| repo::has_commit(&dir2, r));
            let base = repo::read_tree(&dir2, base_rev.as_deref())?;
            let remote = repo::read_tree(&dir2, remote_rev.as_deref())?;
            let local = {
                let conn = db2.lock().map_err(|e| e.to_string())?;
                export(&conn, &prefs2, &base, &pending2)?
            };
            // Sin base y con un repo que ya tiene algo: esta máquina recién llega, gana el repo.
            let first = base_rev.is_none() && remote_rev.is_some();
            let winner = if first { Winner::Remote } else { Winner::Local };
            let (merged, conflicts) = merge3(&base, &local.tree, &remote, winner);
            repo::reset_to(&dir2, remote_rev.as_deref())?;
            repo::write_tree(&dir2, &merged)?;
            let committed = repo::commit_all(&dir2, &format!("Sync from {}", hostname()))?;
            let pushed = match committed {
                Some(_) => match repo::push(&dir2, &env2)? {
                    Push::Done => Some(true),
                    Push::Behind => None,
                },
                None => Some(false),
            };
            Ok((pushed, merged, local, conflicts, first))
        })
        .await
        .map_err(|e| e.to_string())??;
        let (pushed, merged, local, conflicts, first) = step;
        if let Some(pushed) = pushed {
            report.pushed = pushed;
            report.first = first;
            report.conflicts = conflicts.into_iter().map(|c| c.path).collect();
            outcome = Some((merged, local));
            break;
        }
    }
    let Some((merged, local)) = outcome else {
        return Err("Otra máquina está sincronizando al mismo tiempo; probá de nuevo en un momento".into());
    };

    let applied = apply(&app, &data, &merged, &local).await;
    report.changes = applied.changes;
    report.failures = applied.failures;

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Some(head) = repo::head(&dir) {
            set(&conn, "sync.base", &head)?;
        }
        set(&conn, "sync.pending", &serde_json::to_string(&applied.pending).unwrap_or_default())?;
        set(&conn, "sync.last", &serde_json::to_string(&report).unwrap_or_default())?;
    }
    Ok(SyncResult { report, prefs: applied.prefs })
}
