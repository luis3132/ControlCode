//! Conexiones SSH a otras computadoras.
//!
//! ## Para qué
//!
//! Que un agente que corre en ESTA máquina pueda trabajar en otra: correr comandos,
//! mirar logs, copiar archivos. Y que la persona pueda abrir una terminal en cualquiera de
//! ellas con un click. Las conexiones se guardan una vez en Configuración → Conexiones y
//! cada una tiene un nombre corto, que es lo que el agente escribe.
//!
//! ## Por qué con el `ssh` del sistema y no con una biblioteca
//!
//! Porque la conexión es del usuario, no de la app. El `ssh` que ya tiene instalado lee su
//! `~/.ssh/config` (alias, `ProxyJump`, `IdentityFile`), usa su `ssh-agent`, y confía en
//! los equipos de su `known_hosts`. Una biblioteca embebida tendría que reimplementar todo
//! eso, y cada diferencia sería una conexión que anda en la terminal y no en la app.
//!
//! Por el mismo motivo la app no guarda contraseñas ni claves: guarda a dónde ir y, si
//! hace falta, la ruta de la clave que ya está en el disco.
//!
//! ## Lo que ven los agentes
//!
//! Solo las conexiones con `agent_access`, y siempre en modo no interactivo
//! (`BatchMode=yes`): un agente no puede contestar un pedido de contraseña, y esperar uno
//! lo dejaría colgado. Por eso para los agentes hace falta autenticación con clave.
//! Correr un comando remoto no se aprueba solo: lo aprueba la persona cada vez.

mod args;
mod exec;
mod model;
mod store;
pub(crate) mod tools;
#[cfg(test)]
mod test;

pub use args::*;
pub use exec::*;
pub use model::*;
pub use store::*;
pub use tools::{DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS};
