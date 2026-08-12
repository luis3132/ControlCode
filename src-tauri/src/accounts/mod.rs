//! Varias cuentas de una misma TUI, conviviendo.
//!
//! ## Cómo funciona
//!
//! Las CLIs de agentes guardan su login en un directorio propio (`~/.claude`, `~/.codex`,
//! …). Casi todas dejan mover ese directorio con una variable de entorno, y al hacerlo se
//! llevan TODO con él: credenciales, configuración e historial. O sea que "una cuenta" es,
//! literalmente, un directorio: se apunta la variable a otro lado y la TUI arranca como si
//! fuera una instalación nueva, sin tocar la del sistema.
//!
//! Cada cuenta vive en `<datos de la app>/accounts/<agente>/<nombre>`, y lanzar una tab con
//! esa cuenta es pasarle esa variable al PTY — algo que `pty_create` ya sabía hacer para
//! las TUIs custom.
//!
//! ## Por qué no symlinks
//!
//! Tentaba enlazar el directorio "activo" y cambiar el enlace al elegir cuenta. No sirve:
//! las TUIs reescriben sus archivos de credenciales en el lugar, así que dos procesos
//! vivos con cuentas distintas se pisarían a través del mismo enlace, y cambiar de cuenta
//! con una sesión abierta le movería el piso. Una variable por proceso no tiene ese
//! problema: cada tab queda apuntada a su directorio para siempre.
//!
//! ## Qué NO hace este módulo
//!
//! No lee, no copia y no escribe credenciales. El login lo hace la TUI, en su terminal,
//! como si la hubieras abierto a mano; acá solo se crea el directorio vacío y se apunta la
//! variable. Lo único que se lee de adentro es el campo con el mail de la cuenta, para
//! poder mostrar "trabajo → vos@empresa.com" en vez de un nombre suelto.


mod commands;
mod profiles;
mod store;
#[cfg(test)]
mod test;

pub use commands::*;
pub use store::*;
