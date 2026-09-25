//! Cuentas de hosting git (GitHub, GitLab, Gitea/Forgejo o cualquier host) y lo que se hace
//! con ellas: autenticar a git, listar y clonar repos, pull requests e issues.
//!
//! ## Aislado, como VS Code
//!
//! Nada de esto usa `gh`, `glab`, el credential helper del sistema ni los tokens que otras
//! herramientas dejaron en disco. La app tiene su propio login (código de dispositivo por
//! OAuth, o un token pegado a mano) y guarda el token en el llavero del sistema (ver
//! [`secret`]). Iniciar o cerrar sesión acá no toca nada de afuera, y lo de afuera no
//! cambia lo que ve la app.
//!
//! ## Cómo le llega la cuenta a git
//!
//! Por variables de entorno del proceso de git, nunca por su configuración: ver
//! [`credentials::git_env`]. El token no pasa por la línea de comandos (se vería en `ps`)
//! ni se escribe en `.git/config`.
//!
//! ## Los modelos
//!
//! Los agentes usan la cuenta por el MCP de la app (ver [`tools`]): piden "abrí un PR" o
//! "subí la rama" y la app lo hace con la cuenta. El token nunca sale de la app.

mod api;
mod commands;
mod credentials;
mod oauth;
mod provider;
mod secret;
mod store;
pub(crate) mod tools;
#[cfg(test)]
mod test;

pub use commands::*;
pub(crate) use credentials::git_env;

/// Lo que usa la sincronización (ver `crate::sync`): la API de una cuenta y cómo
/// autenticar a git con ella, sin exponer el resto del módulo.
pub(crate) mod for_sync {
    pub(crate) use super::api::Api;
    pub(crate) use super::credentials::git_env_for_url;
    pub(crate) use super::provider::{ForgeError, ForgeKind};
    pub(crate) use super::store::GitAccount;

    /// La cuenta y su API (con el token renovado si hacía falta).
    pub(crate) async fn account_api(app: &tauri::AppHandle, account_id: &str) -> Result<(GitAccount, Api), ForgeError> {
        let account = super::store::get(&super::store::db(app)?.lock().unwrap(), account_id)
            .ok_or_else(|| ForgeError::Api("Esa cuenta de git ya no existe".into()))?;
        let token = super::credentials::token(app, &account).await?;
        let api = Api::new(account.kind, &account.host, &token)?;
        Ok((account, api))
    }
}
