//! Piezas chicas que no son de ningún dominio en particular.

pub mod path_env;
mod proc;
mod time;
#[cfg(test)]
mod test;

pub use path_env::{find_program, program};
pub use proc::output_with_timeout;
pub use time::now_ts;
