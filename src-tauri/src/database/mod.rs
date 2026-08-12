//! Persistencia SQLite de la app.
//!
//! - [`connection`] — dónde vive la base, cómo se abre y el handle compartido.
//! - [`schema`] — el DDL y sus migraciones.
//! - [`seeds`] — las filas que la app siembra sola al primer arranque.
//! - [`models`] — los tipos que viajan al frontend.
//! - [`queries`] — el SQL, agrupado por dominio.

mod connection;
mod models;
mod queries;
mod schema;
mod seeds;
#[cfg(test)]
mod test;

pub use connection::{init_db, DbConnection};

/// Base en memoria con el schema real, para los tests de cualquier módulo.
#[cfg(test)]
pub(crate) use schema::in_memory as test_db;
pub use models::*;
pub use queries::*;
