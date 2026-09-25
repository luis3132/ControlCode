//! De la cuenta a git y a la API: qué repo es, con qué cuenta, y cómo se autentica git.
//!
//! ## Por qué variables de entorno
//!
//! Git lee configuración de `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
//! (desde 2.31) con la misma prioridad que un `-c` en la línea de comandos, pero sin que el
//! valor aparezca en `ps`. Con eso, para cada host que tiene cuenta:
//!
//! - `http.https://<host>/.extraheader = Authorization: Basic …` — git manda el token en
//!   cada pedido a ese host, y a ningún otro (la clave lleva la URL).
//! - `credential.https://<host>.helper = ""` — vacía la lista de helpers para ese host.
//!   Si el token dejó de valer, que falle con "autenticación" en vez de que git le pregunte
//!   al helper del sistema (`gh`, el de Git Credential Manager) y termine usando OTRA
//!   cuenta sin que nadie lo note. Eso es lo que hace que la app esté aislada.
//!
//! Nada de esto se escribe en `.git/config` ni en el `~/.gitconfig`: vive lo que dura el
//! proceso de git.
//!
//! Los remotos por SSH no cambian: usan la llave SSH del usuario, como siempre.

use base64::Engine;

use super::oauth;
use super::provider::{bare_host, ForgeError, ForgeKind};
use super::secret::{self, Secret};
use super::store::{self, data_dir, db, GitAccount};
use crate::util::now_ts;

pub(super) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// El token de la cuenta, renovado si venció (o está por vencer).
pub(super) async fn token(app: &tauri::AppHandle, account: &GitAccount) -> Result<String, ForgeError> {
    let dir = data_dir(app)?;
    let id = account.id.clone();
    let load_dir = dir.clone();
    let secret: Secret = blocking(move || secret::load(&load_dir, &id))
        .await?
        .map_err(ForgeError::Auth)?;
    let expiring = secret.expires_at.is_some_and(|at| at - 60 < now_ts());
    match (&secret.refresh_token, expiring) {
        (Some(refresh), true) => {
            let fresh = oauth::refresh(account.kind, &account.host, refresh).await.map_err(ForgeError::Auth)?;
            let token = fresh.access_token.clone();
            let id = account.id.clone();
            blocking(move || secret::save(&dir, &id, &fresh)).await??;
            Ok(token)
        }
        _ => Ok(secret.access_token),
    }
}

/// Qué repo es y con qué cuenta se trabaja en él.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTarget {
    pub root: String,
    pub remote: String,
    pub remote_url: String,
    /// Sin puerto, como lo trae el remoto.
    pub host: String,
    /// `owner/repo`, sin `.git`.
    pub path: String,
    pub kind: Option<ForgeKind>,
    pub account: Option<GitAccount>,
    /// Todas las cuentas de ese host, para elegir si hay más de una.
    pub accounts: Vec<GitAccount>,
    /// Si el remoto va por SSH: git no usa la cuenta para empujar (sí la API).
    pub ssh: bool,
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args).env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::util::output_with_timeout(&mut cmd, std::time::Duration::from_secs(10)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub(super) fn repo_root(cwd: &str) -> Option<String> {
    git(cwd, &["rev-parse", "--show-toplevel"]).filter(|s| !s.is_empty())
}

fn remotes(root: &str) -> Vec<(String, String)> {
    let raw = git(root, &["remote", "-v"]).unwrap_or_default();
    crate::scm::parse_remotes(&raw).into_iter().map(|r| (r.name, r.url)).collect()
}

/// Resuelve el repo que contiene `cwd`. Errores que la UI y el agente saben leer: sin
/// repo, sin remoto, o sin cuenta para su host.
pub(super) async fn target(app: &tauri::AppHandle, cwd: &str) -> Result<RepoTarget, ForgeError> {
    let cwd = cwd.to_string();
    let (root, remotes) = blocking(move || {
        let root = repo_root(&cwd)?;
        let remotes = remotes(&root);
        Some((root, remotes))
    })
    .await?
    .ok_or_else(|| ForgeError::Unsupported("This folder is not inside a git repository.".into()))?;

    let (remote, remote_url) = remotes
        .iter()
        .find(|(name, _)| name == "origin")
        .or_else(|| remotes.first())
        .cloned()
        .ok_or_else(|| ForgeError::Unsupported("The repository has no remote.".into()))?;
    let (host, path) = crate::scm::host_and_path(&remote_url)
        .ok_or_else(|| ForgeError::Unsupported(format!("Unrecognized remote URL: {remote_url}")))?;
    let host = host.strip_prefix("ssh.").unwrap_or(&host).to_string();
    let path = path.trim_start_matches('/').trim_end_matches('/').trim_end_matches(".git").to_string();

    let conn = db(app)?;
    let (account, accounts) = store::pick(&conn.lock().unwrap(), Some(&root), &host);
    let kind = account.as_ref().map(|a| a.kind).or_else(|| ForgeKind::guess(&host));
    let ssh = !remote_url.starts_with("https://") && !remote_url.starts_with("http://");
    Ok(RepoTarget { root, remote, remote_url, host, path, kind, account, accounts, ssh })
}

/// El host con puerto de una URL HTTPS, sin usuario. `None` si no es HTTPS.
pub(super) fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_lowercase())
}

pub(super) fn basic(user: &str, token: &str) -> String {
    let raw = format!("{user}:{token}");
    format!("Authorization: Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
}

/// Las variables que hacen que git se autentique con las cuentas de la app.
pub(super) fn env_for(entries: &[(String, String)]) -> Vec<(String, String)> {
    if entries.is_empty() {
        return Vec::new();
    }
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), entries.len().to_string())];
    for (i, (key, value)) in entries.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{i}"), key.clone()));
        env.push((format!("GIT_CONFIG_VALUE_{i}"), value.clone()));
    }
    env
}

/// La clave usa el host de la CUENTA, con su puerto si tiene: git lo compara.
fn entries_for(account: &GitAccount, token: &str) -> Vec<(String, String)> {
    let user = account.kind.git_user(&account.login, account.git_user.as_deref());
    let url_host = &account.host;
    vec![
        (format!("http.https://{url_host}/.extraheader"), basic(&user, token)),
        (format!("credential.https://{url_host}.helper"), String::new()),
    ]
}

/// Las variables de git para operar en `root`: una entrada por cada remoto HTTPS cuyo host
/// tiene cuenta. Un remoto sin cuenta queda como estaba (lo que git tenga configurado).
pub(crate) async fn git_env(app: &tauri::AppHandle, root: &str) -> Vec<(String, String)> {
    let r = root.to_string();
    let remotes = blocking(move || remotes(&r)).await.unwrap_or_default();
    let mut hosts: Vec<String> = remotes.iter().filter_map(|(_, url)| https_host(url)).collect();
    hosts.sort();
    hosts.dedup();

    let mut entries = Vec::new();
    for host in hosts {
        let account = match db(app) {
            Ok(conn) => store::pick(&conn.lock().unwrap(), Some(root), bare_host(&host)).0,
            Err(_) => None,
        };
        let Some(account) = account else { continue };
        match token(app, &account).await {
            Ok(token) => entries.extend(entries_for(&account, &token)),
            Err(e) => eprintln!("[forge] sin token para {host}: {e}"),
        }
    }
    env_for(&entries)
}

/// Lo mismo para una URL suelta (clonar): con la cuenta dada, o la primera de su host.
pub(crate) async fn git_env_for_url(
    app: &tauri::AppHandle,
    url: &str,
    account_id: Option<&str>,
) -> Result<Vec<(String, String)>, ForgeError> {
    let Some(host) = https_host(url) else { return Ok(Vec::new()) };
    let account = {
        let conn = db(app)?;
        let conn = conn.lock().unwrap();
        match account_id {
            Some(id) => store::get(&conn, id),
            None => store::for_host(&conn, bare_host(&host)).into_iter().next(),
        }
    };
    let Some(account) = account else { return Ok(Vec::new()) };
    let token = token(app, &account).await?;
    Ok(env_for(&entries_for(&account, &token)))
}

/// La API del repo, con su cuenta. Sin cuenta es `NoAccount(host)`: la UI ofrece iniciar
/// sesión justo en ese host.
pub(super) async fn api_for(app: &tauri::AppHandle, target: &RepoTarget) -> Result<super::api::Api, ForgeError> {
    let account = target.account.as_ref().ok_or_else(|| ForgeError::NoAccount(target.host.clone()))?;
    let token = token(app, account).await?;
    super::api::Api::new(account.kind, &account.host, &token)
}
