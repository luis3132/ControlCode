//! Control de versiones del panel derecho: el estado del repo y lo que se hace con él
//! (preparar, descartar, commitear, cambiar de rama, sincronizar).
//!
//! Igual que el explorador, todo sale de invocar `git`: el resultado es el que vería el
//! usuario en su terminal, con su configuración, sus hooks y sus credenciales.
//!
//! Las operaciones de red pasan por un único lugar (`git::network`). Hoy usan lo que git
//! ya tenga configurado — credential helper, agente SSH —; es ahí donde va a entrar el
//! login con GitHub/GitLab cuando exista, sin tocar el resto.

mod commands;
mod git;
mod parse;
mod remote;
#[cfg(test)]
mod test;

pub use commands::*;
