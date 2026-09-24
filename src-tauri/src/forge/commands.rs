//! Los comandos que usa la UI: cuentas, repos en la nube, clonar, PRs e issues.

use serde::Serialize;
use tauri::AppHandle;

use super::api::{normalize_state, Api, ForgeRepo, ForgeUser, Item, ItemDetail, NewIssue, NewPull};
use super::credentials::{api_for, blocking, git_env, git_env_for_url, target, RepoTarget};
use super::oauth::{self, DeviceStart, Poll};
use super::provider::{normalize_host, ForgeError, ForgeKind};
use super::secret::{self, Secret};
use super::store::{self, data_dir, db, GitAccount};
use crate::util::now_ts;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeKindInfo {
    pub kind: ForgeKind,
    pub default_host: Option<&'static str>,
    /// Si ese host por defecto tiene inicio de sesión con navegador.
    pub oauth: bool,
    pub api: bool,
}

#[tauri::command]
pub fn forge_kinds() -> Vec<ForgeKindInfo> {
    [ForgeKind::Github, ForgeKind::Gitlab, ForgeKind::Gitea, ForgeKind::Other]
        .into_iter()
        .map(|kind| ForgeKindInfo {
            kind,
            default_host: kind.default_host(),
            oauth: kind.default_host().is_some_and(|h| oauth::available(kind, h)),
            api: kind.has_api(),
        })
        .collect()
}

/// Si un host concreto (uno propio) tiene inicio de sesión con navegador.
#[tauri::command]
pub fn forge_oauth_available(kind: ForgeKind, host: String) -> bool {
    normalize_host(&host).is_ok_and(|h| oauth::available(kind, &h))
}

#[tauri::command]
pub async fn forge_accounts(app: AppHandle) -> Result<Vec<GitAccount>, String> {
    store::list_with_storage(&app)
}

async fn save_account(
    app: &AppHandle,
    kind: ForgeKind,
    host: &str,
    auth: &str,
    secret: Secret,
    user: ForgeUser,
    git_user: Option<String>,
) -> Result<GitAccount, String> {
    let mut account = GitAccount {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        host: host.to_string(),
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
        auth: auth.to_string(),
        git_user,
        created_at: now_ts(),
        storage: None,
    };
    account.id = store::upsert(&db(app)?.lock().unwrap(), &account)?;
    let dir = data_dir(app)?;
    let id = account.id.clone();
    account.storage = Some(blocking(move || secret::save(&dir, &id, &secret)).await??);
    Ok(account)
}

#[tauri::command]
pub async fn forge_device_start(kind: ForgeKind, host: String) -> Result<DeviceStart, String> {
    let host = normalize_host(&host)?;
    oauth::start(kind, &host).await
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DevicePoll {
    Pending { interval: u64 },
    Done { account: GitAccount },
    Expired,
    Denied,
}

#[tauri::command]
pub async fn forge_device_poll(app: AppHandle, flow_id: String) -> Result<DevicePoll, String> {
    Ok(match oauth::poll(&flow_id).await? {
        Poll::Pending { interval } => DevicePoll::Pending { interval },
        Poll::Expired => DevicePoll::Expired,
        Poll::Denied => DevicePoll::Denied,
        Poll::Done { kind, host, secret } => {
            let user = Api::new(kind, &host, &secret.access_token)
                .map_err(|e| e.to_string())?
                .me()
                .await
                .map_err(|e| e.to_string())?;
            let account = save_account(&app, kind, &host, "oauth", secret, user, None).await?;
            DevicePoll::Done { account }
        }
    })
}

#[tauri::command]
pub fn forge_device_cancel(flow_id: String) {
    oauth::cancel(&flow_id);
}

/// Una cuenta con un token pegado a mano. Para los hosts con API se valida contra el host
/// (y de ahí sale el login); uno genérico no tiene contra qué validar, así que el usuario
/// dice con qué usuario se presenta.
#[tauri::command]
pub async fn forge_add_token(
    app: AppHandle,
    kind: ForgeKind,
    host: String,
    token: String,
    username: Option<String>,
) -> Result<GitAccount, String> {
    let host = normalize_host(&host)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Falta el token".to_string());
    }
    let username = username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let user = if kind.has_api() {
        Api::new(kind, &host, &token).map_err(|e| e.to_string())?.me().await.map_err(|e| e.to_string())?
    } else {
        let login = username.clone().ok_or("Para un host genérico hace falta el usuario")?;
        ForgeUser { login, name: None, avatar_url: None }
    };
    let secret = Secret { access_token: token, refresh_token: None, expires_at: None };
    let git_user = if kind == ForgeKind::Other { username } else { None };
    save_account(&app, kind, &host, "token", secret, user, git_user).await
}

/// Cierra la sesión: borra la cuenta y su token del llavero. En el host el token sigue
/// existiendo hasta que se revoque allá (la UI lo dice).
#[tauri::command]
pub async fn forge_remove_account(app: AppHandle, id: String) -> Result<(), String> {
    store::delete(&db(&app)?.lock().unwrap(), &id)?;
    let dir = data_dir(&app)?;
    blocking(move || secret::delete(&dir, &id)).await
}

fn account(app: &AppHandle, id: &str) -> Result<GitAccount, ForgeError> {
    store::get(&db(app)?.lock().unwrap(), id).ok_or_else(|| ForgeError::Api("Esa cuenta ya no existe".into()))
}

#[tauri::command]
pub async fn forge_repos(app: AppHandle, account_id: String) -> Result<Vec<ForgeRepo>, ForgeError> {
    let account = account(&app, &account_id)?;
    let token = super::credentials::token(&app, &account).await?;
    Api::new(account.kind, &account.host, &token)?.repos().await
}

/// El nombre de carpeta que git le daría al clon: el último tramo de la URL, sin `.git`.
pub(super) fn clone_dir_name(url: &str) -> Option<String> {
    let last = url.trim().trim_end_matches('/').rsplit(['/', ':']).next()?;
    let name = last.trim_end_matches(".git");
    (!name.is_empty() && name != "." && name != "..").then(|| name.to_string())
}

/// Clona `url` dentro de `parent` y devuelve la carpeta nueva. Con la cuenta dada, o la
/// primera del host; un host sin cuenta clona con lo que git tenga (un repo público no
/// necesita nada).
#[tauri::command]
pub async fn forge_clone(
    app: AppHandle,
    url: String,
    parent: String,
    name: Option<String>,
    account_id: Option<String>,
) -> Result<String, ForgeError> {
    let url = url.trim().to_string();
    if url.is_empty() || url.starts_with('-') {
        return Err(ForgeError::Api("URL de repositorio inválida".into()));
    }
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| clone_dir_name(&url))
        .ok_or_else(|| ForgeError::Api("No se pudo deducir el nombre de la carpeta".into()))?;
    if name.contains(['/', '\\']) || name == "." || name == ".." || name.starts_with('-') {
        return Err(ForgeError::Api(format!("«{name}» no es un nombre de carpeta válido")));
    }
    let parent_path = std::path::PathBuf::from(&parent);
    if !parent_path.is_dir() {
        return Err(ForgeError::Api(format!("La carpeta {parent} no existe")));
    }
    let dest = parent_path.join(&name);
    if dest.exists() {
        return Err(ForgeError::Api(format!("Ya existe {}", dest.display())));
    }
    let env = git_env_for_url(&app, &url, account_id.as_deref()).await?;
    let dest_str = dest.to_string_lossy().into_owned();
    blocking(move || {
        crate::scm::network_with(
            &parent,
            &["clone", "--", &url, &name],
            &env,
            std::time::Duration::from_secs(30 * 60),
        )
    })
    .await?
    .map_err(scm_to_forge)?;
    Ok(dest_str)
}

fn scm_to_forge(e: crate::scm::ScmError) -> ForgeError {
    match e {
        crate::scm::ScmError::Auth(m) => ForgeError::Auth(m),
        crate::scm::ScmError::Git(m) => ForgeError::Api(m),
    }
}

/// El repo del workspace y su cuenta. `None` si no hay repo o no tiene remoto: no es un
/// error, simplemente no hay nube con qué hablar.
#[tauri::command]
pub async fn forge_repo(app: AppHandle, cwd: String) -> Result<Option<RepoTarget>, ForgeError> {
    match target(&app, &cwd).await {
        Ok(t) => Ok(Some(t)),
        Err(ForgeError::Unsupported(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn forge_set_repo_account(app: AppHandle, root: String, account_id: String) -> Result<(), String> {
    store::set_repo_choice(&db(&app)?.lock().unwrap(), &root, &account_id)
}

async fn repo_api(app: &AppHandle, cwd: &str) -> Result<(RepoTarget, Api), ForgeError> {
    let t = target(app, cwd).await?;
    let api = api_for(app, &t).await?;
    Ok((t, api))
}

#[tauri::command]
pub async fn forge_pulls(app: AppHandle, cwd: String, state: Option<String>) -> Result<Vec<Item>, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    api.pulls(&t.path, normalize_state(state.as_deref())).await
}

#[tauri::command]
pub async fn forge_issues(app: AppHandle, cwd: String, state: Option<String>) -> Result<Vec<Item>, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    api.issues(&t.path, normalize_state(state.as_deref())).await
}

#[tauri::command]
pub async fn forge_item(app: AppHandle, cwd: String, number: u64, pr: bool) -> Result<ItemDetail, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    api.item(&t.path, number, pr).await
}

#[tauri::command]
pub async fn forge_create_pull(app: AppHandle, cwd: String, pull: NewPull) -> Result<Item, ForgeError> {
    if pull.title.trim().is_empty() {
        return Err(ForgeError::Api("Falta el título".into()));
    }
    let (t, api) = repo_api(&app, &cwd).await?;
    api.create_pull(&t.path, &pull).await
}

#[tauri::command]
pub async fn forge_create_issue(app: AppHandle, cwd: String, issue: NewIssue) -> Result<Item, ForgeError> {
    if issue.title.trim().is_empty() {
        return Err(ForgeError::Api("Falta el título".into()));
    }
    let (t, api) = repo_api(&app, &cwd).await?;
    api.create_issue(&t.path, &issue).await
}

#[tauri::command]
pub async fn forge_comment(app: AppHandle, cwd: String, number: u64, pr: bool, body: String) -> Result<(), ForgeError> {
    if body.trim().is_empty() {
        return Err(ForgeError::Api("El comentario está vacío".into()));
    }
    let (t, api) = repo_api(&app, &cwd).await?;
    api.comment(&t.path, number, pr, &body).await
}

#[tauri::command]
pub async fn forge_merge_pull(app: AppHandle, cwd: String, number: u64, method: String) -> Result<(), ForgeError> {
    let method = match method.as_str() {
        "squash" | "rebase" => method,
        _ => "merge".to_string(),
    };
    let (t, api) = repo_api(&app, &cwd).await?;
    api.merge(&t.path, number, &method).await
}

#[tauri::command]
pub async fn forge_default_branch(app: AppHandle, cwd: String) -> Result<Option<String>, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    api.default_branch(&t.path).await
}

/// Trae un PR como rama local `pr/<n>` y se cambia a ella, para probarlo o revisarlo.
#[tauri::command]
pub async fn forge_checkout_pull(app: AppHandle, cwd: String, number: u64) -> Result<String, ForgeError> {
    let (t, api) = repo_api(&app, &cwd).await?;
    let head_ref = api.pull_head_ref(number);
    let env = git_env(&app, &t.root).await;
    blocking(move || checkout_pull(&t, number, &head_ref, &env)).await?
}

fn checkout_pull(t: &RepoTarget, number: u64, head_ref: &str, env: &[(String, String)]) -> Result<String, ForgeError> {
    use crate::scm::{network, run_local};
    let branch = format!("pr/{number}");
    let tracking = format!("refs/remotes/{}/pr/{number}", t.remote);
    // A una ref de seguimiento y no a la rama local: si la rama es la actual, git se
    // niega a escribirle encima con un fetch.
    network(&t.root, &["fetch", &t.remote, &format!("+{head_ref}:{tracking}")], env).map_err(scm_to_forge)?;
    let exists = run_local(&t.root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        run_local(&t.root, &["switch", &branch]).map_err(scm_to_forge)?;
        // Solo avanza si no hay nada local encima: un commit propio en la rama del PR no
        // se pisa.
        let _ = run_local(&t.root, &["merge", "--ff-only", &tracking]);
    } else {
        run_local(&t.root, &["switch", "-c", &branch, &tracking]).map_err(scm_to_forge)?;
    }
    Ok(branch)
}
