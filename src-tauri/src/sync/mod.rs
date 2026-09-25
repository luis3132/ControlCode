//! Sincronización de skills y configuración por un repo git privado del usuario.
//!
//! El usuario elige una de sus cuentas de git (ver `forge`) y la app crea ahí un repo
//! privado (o usa el que ya creó otra máquina). Cada máquina conectada sube lo suyo y trae
//! lo de las demás: las skills que el usuario creó o editó, qué skills de qué
//! repositorios tiene instaladas, y sus preferencias.
//!
//! - [`tree`]: el contenido como mapa ruta → bytes, y la mezcla de tres vías.
//! - [`export`]: de esta máquina al árbol (y qué NO va nunca: tokens, logins, cookies…).
//! - [`import`]: del árbol a esta máquina.
//! - [`repo`]: el clon local y git.
//! - [`commands`]: lo que llama la UI.

mod commands;
mod export;
mod import;
mod repo;
mod tree;
#[cfg(test)]
mod test;

pub use commands::*;
