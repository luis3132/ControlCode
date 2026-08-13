//! Las TUIs que la app sabe lanzar: las soportadas de fábrica y las que agrega el usuario.

mod custom;
mod detector;
#[cfg(test)]
mod test;

pub use custom::*;
pub use detector::*;
