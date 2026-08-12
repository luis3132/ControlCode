//! Todo el SQL de la app, agrupado por lo que consulta.
//!
//! La conexión y el schema viven un nivel más arriba (`database::connection`,
//! `database::schema`); acá solo hay lecturas y escrituras sobre tablas ya creadas.

mod sessions;
mod settings;
mod windows;
mod workspaces;

pub use sessions::*;
pub use settings::*;
pub use windows::*;
pub use workspaces::*;
