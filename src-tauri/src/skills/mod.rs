//! Fase 5 — Skills: una copia global por skill, montada en los proyectos por symlink.
//!
//! - [`types`] — lo que se guarda y lo que ve el frontend.
//! - [`frontmatter`] / [`files`] — leer y escribir un SKILL.md en disco.
//! - [`settings`] — el directorio global donde viven las copias.
//! - [`install`] — instalar y desinstalar.
//! - [`authoring`] — crear skills propias y editar las que vinieron de un repositorio.
//! - [`store`] — consultar y editar las instaladas.
//! - [`links`] — los symlinks: qué skill va montada en qué tab.
//! - [`sessions`] — recuperar las skills de una sesión archivada.
//! - [`bundled`] — las que viajan con la app y se instalan solas.

mod authoring;
mod bundled;
mod files;
mod frontmatter;
mod install;
mod links;
mod sessions;
mod settings;
mod store;
mod types;
#[cfg(test)]
mod test;

pub use authoring::*;
pub use bundled::ensure_bundled_skills;
pub(crate) use frontmatter::{rename_in_content, scan_frontmatter_for_marketplace};
pub use install::*;
pub use links::*;
pub use sessions::*;
pub use settings::*;
pub use store::*;
pub use types::*;
