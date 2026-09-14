//! Fase 8 — La app expuesta a la CLI `ccode`.
//!
//! - [`server`] — el socket que escucha y despacha.
//! - [`protocol`] — el formato del mensaje y el handshake, compartido con la CLI.
//! - [`commands`] — un handler por comando.
//! - [`bridge`] — el puente al frontend, para lo que solo él sabe.
//! - [`install`] — instalar/desinstalar el binario `ccode` en el PATH del usuario.
//! - [`mcp`] — el puente por el que un agente headless pide permiso.

pub mod bridge;
mod commands;
pub mod install;
pub mod mcp;
pub mod protocol;
mod server;
#[cfg(test)]
mod test;

pub use server::{cleanup, start};
