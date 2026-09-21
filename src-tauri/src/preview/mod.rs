//! El navegador de las tabs: un proxy local delante del proyecto que se quiere probar.
//!
//! El navegador es un `<iframe>`, y un iframe de otro origen es una caja cerrada: desde la
//! app no se puede leer ni tocar lo que hay adentro. Eso impide lo único que lo diferencia
//! de abrir el navegador del sistema — marcar un elemento de la página para mandárselo a
//! un agente. El proxy lo resuelve sin abrir nada: pasa las peticiones al servidor de
//! desarrollo tal cual, y a las páginas HTML les agrega un script propio (el selector,
//! `src/features/browser/picker.ts`) que sí vive adentro y habla con la app por `postMessage`.
//!
//! Se descartó un webview nativo hijo: se dibuja siempre por encima del HTML, así que
//! cualquier diálogo o menú de la app que pasara por esa zona quedaría tapado, y habría que
//! reposicionarlo a mano con cada cambio de layout.

mod capture;
mod log;
mod mocks;
mod proxy;
mod rewrite;
mod site;
mod snapshot;
#[cfg(test)]
mod test;

pub use capture::*;
pub use proxy::*;
pub use site::set_state_dir;
