//! El relay de Control Code: lo que conecta la app de escritorio con la app móvil.
//!
//! - [`crypto`] — las claves, el cifrado de punta a punta y los ids.
//! - [`protocol`] — los mensajes: los que entiende el relay y los que viajan cifrados.
//! - `server` — el servidor WebSocket (feature `server`, la de por defecto).
//!
//! El protocolo completo está en `docs/remote-protocol.md`.

pub mod crypto;
pub mod protocol;
#[cfg(feature = "server")]
pub mod server;
