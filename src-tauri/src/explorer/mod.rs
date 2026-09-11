//! El árbol de archivos del workspace y su estado en git.
//!
//! Es lo que alimenta al panel derecho: qué hay en la carpeta y qué cambió. No cachea
//! nada — el frontend pide un nivel a la vez y vuelve a preguntar cuando hace falta.

mod git;
mod tree;
#[cfg(test)]
mod test;

pub use git::*;
pub use tree::*;
