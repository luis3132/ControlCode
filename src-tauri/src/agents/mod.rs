//! Las TUIs que la app sabe lanzar: las soportadas de fábrica y las que agrega el usuario.
//!
//! [`registry`] es la tabla única de las de fábrica — todo lo tabular de una TUI vive en
//! una sola fila ahí. [`detector`] le agrega lo que solo se sabe sondeando esta máquina
//! (si está instalada y con qué versión), y [`custom`] guarda las que declara el usuario.

mod custom;
mod detector;
mod registry;
#[cfg(test)]
mod test;

pub use custom::*;
pub use detector::*;
pub use registry::*;
