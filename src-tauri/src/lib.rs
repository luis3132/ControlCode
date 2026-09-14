//! Control Code — el backend de la app.
//!
//! Cada módulo cubre un dominio; `app` es el que los ensambla y arranca Tauri.

mod accounts;
mod agents;
mod app;
mod database;
mod explorer;
pub mod ipc;
mod marketplace;
mod orchestrator;
mod prelaunch;
mod preview;
mod runs;
mod scm;
mod session;
mod skills;
mod terminal;
mod usage;
mod util;
mod window;

pub use app::run;
