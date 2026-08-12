//! Fase 6 — Marketplace y repositorios de skills configurables.
//!
//! Formato abierto de `registry.json` (opcional — sin él, se auto-escanean carpetas con
//! `SKILL.md` dentro de la fuente):
//! ```json
//! {
//!   "name": "Mi repo de skills",
//!   "skills": [
//!     {
//!       "id": "mi-skill",                 // opcional, default: nombre de la carpeta
//!       "name": "Mi Skill",               // opcional, default: id
//!       "description": "...",
//!       "path": "skills/mi-skill",        // carpeta relativa a la raíz del registry, contiene SKILL.md
//!       "categories": ["git"],
//!       "compatibleAgents": ["claude-code"]
//!     }
//!   ]
//! }
//! ```
//!
//! Una fuente por módulo: [`local`] (carpeta en disco), [`github`] (repo público, vía la
//! API de GitHub — sin autenticación, sujeto a su rate limit anónimo) y [`skillssh`] (el
//! directorio abierto de <https://skills.sh>, a través de su CLI oficial). Lo común a
//! todas —el CRUD de repositorios y su cache— vive en [`registries`].
//!
//! "URL con manifest JSON" genérica y "git genérico" (clonar cualquier remoto) quedan
//! pendientes del plan original: requieren descubrir el listado de archivos de un servidor
//! HTTP arbitrario (no hay una API estándar para eso) y traer un cliente git embebido
//! respectivamente — ninguna de las dos es segura de improvisar sin poder probarla contra
//! una fuente real.

mod github;
mod local;
mod registries;
mod skillssh;
mod types;
#[cfg(test)]
mod test;

pub use registries::*;
pub use skillssh::*;
pub use types::*;
