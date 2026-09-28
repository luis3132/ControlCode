//! Control remoto desde el teléfono.
//!
//! La app se conecta **hacia afuera** a un relay auto-alojado (`relay/` en este repo) y
//! por ahí habla con los teléfonos emparejados. Todo va cifrado de punta a punta
//! (`crypto_box` de NaCl): el relay reenvía sin poder leer. El protocolo completo está en
//! `docs/remote-protocol.md`; los tipos y el cifrado se comparten con el relay
//! (`controlcode_relay`), así no pueden desincronizarse.
//!
//! - [`config`] — dirección del relay, token, nombre del equipo y su par de claves.
//! - [`devices`] — los teléfonos emparejados.
//! - [`pairing`] — el QR de un solo uso para emparejar uno nuevo.
//! - [`client`] — la conexión al relay: reconecta sola y lleva la presencia.
//! - [`handlers`] — lo que un teléfono puede pedir.
//! - [`live`] — la salida de las tabs que un teléfono está mirando, en vivo.
//! - [`asks`] — las preguntas de los agentes (`ask_user`) que se pueden contestar desde ahí.
//! - [`push`] — las notificaciones cuando el teléfono no está conectado.
//!
//! ## Qué puede hacer un teléfono
//!
//! Lo mismo que la CLI `ccode` en esta computadora: ver y escribir en las tabs, abrir
//! agentes, aprobar permisos y contestar preguntas. Por eso emparejar exige el QR que se
//! muestra en la pantalla de esta computadora, y un teléfono se puede desemparejar desde
//! Configuración en cualquier momento.

pub mod asks;
mod client;
mod commands;
mod config;
mod devices;
mod handlers;
pub mod live;
mod pairing;
mod push;
#[cfg(test)]
mod test;

pub use client::{on_approvals_changed, start};
pub use commands::*;
