//! El árbol de archivos del workspace, su estado en git, el buscador y la lectura de
//! archivos para las tabs.
//!
//! Es lo que alimenta al panel derecho: qué hay en la carpeta y qué cambió. No cachea
//! nada — el frontend pide un nivel a la vez, y `watch` le avisa qué carpetas abiertas
//! cambiaron para que vuelva a pedir solo esas.

pub mod commands;
mod files;
mod git;
mod ops;
mod search;
mod tree;
pub mod watch;
#[cfg(test)]
mod test;

pub use files::*;
pub use git::*;
pub use ops::*;
pub use search::*;
pub use tree::*;
