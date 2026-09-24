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
