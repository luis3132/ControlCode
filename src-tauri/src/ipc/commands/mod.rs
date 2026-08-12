//! Los comandos que atiende el servidor IPC, uno por dominio.

mod agents;
mod app;
mod dispatch;
mod shared;
mod skills;
mod tabs;
mod watch;
mod windows;
mod workspaces;

pub use dispatch::dispatch;

#[cfg(test)]
pub(crate) use agents::{match_account_id, match_preset_id};
#[cfg(test)]
pub(crate) use tabs::{init_prompt, match_skill_ids, skill_names};
