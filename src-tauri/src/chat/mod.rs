//! El modo HTML de las tabs de Claude Code: la conversación dibujada por la app en vez de
//! la TUI, con un turno `claude -p` por mensaje (ver `session.rs`).

pub mod commands;
pub(crate) mod launch;
pub mod models;
pub mod parse;
pub mod session;
#[cfg(test)]
mod test;

pub use session::kill_all;
