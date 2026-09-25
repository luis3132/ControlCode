//! Control de versiones del panel derecho: el estado del repo y lo que se hace con él
//! (preparar, descartar, commitear, cambiar de rama, sincronizar).
//!
//! Igual que el explorador, todo sale de invocar `git`: el resultado es el que vería el
//! usuario en su terminal, con su configuración, sus hooks y sus credenciales.
//!
//! Las operaciones de red pasan por un único lugar (`git::network`), que recibe las
//! variables con las que git se autentica con la cuenta de la app (ver `forge`). Un remoto
//! sin cuenta sigue usando lo que git ya tenga configurado — credential helper, agente SSH.

mod commands;
mod git;
mod parse;
mod remote;
#[cfg(test)]
mod test;

pub use commands::*;
pub(crate) use commands::{create_tag, push_tag, sync, Sync};
pub(crate) use remote::{host_and_path, parse_remotes, provider_of, Provider};
pub(crate) use git::{network, network_with, ScmError};

/// Un git local, con el mismo entorno que el panel (sin terminal, con tiempo límite).
pub(crate) fn run_local(root: &str, args: &[&str]) -> Result<String, ScmError> {
    git::run_text(root, args, git::LOCAL)
}

/// Lo mismo, devolviendo los bytes tal cual (archivos binarios).
pub(crate) fn run_bytes(root: &str, args: &[&str]) -> Result<Vec<u8>, ScmError> {
    git::run(root, args, git::LOCAL)
}
