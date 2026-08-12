//! Piezas chicas que no son de ningún dominio en particular.

mod proc;
mod time;
#[cfg(test)]
mod test;

pub use proc::output_with_timeout;
pub use time::now_ts;
