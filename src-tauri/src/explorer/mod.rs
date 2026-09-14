//! El árbol de archivos del workspace, su estado en git, el buscador y la lectura de
//! archivos para las tabs.
//!
//! Es lo que alimenta al panel derecho: qué hay en la carpeta y qué cambió. No cachea
//! nada — el frontend pide un nivel a la vez y vuelve a preguntar cuando hace falta.

mod files;
mod git;
mod search;
mod tree;
#[cfg(test)]
mod test;

pub use files::*;
pub use git::*;
pub use search::*;
pub use tree::*;
