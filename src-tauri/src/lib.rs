//! Control Code — el backend de la app.
//!
//! Cada módulo cubre un dominio; `app` es el que los ensambla y arranca Tauri.

mod accounts;
mod agents;
mod app;
mod database;
pub mod ipc;
mod marketplace;
mod orchestrator;
mod prelaunch;
mod session;
mod skills;
mod terminal;
mod window;

pub use app::run;
