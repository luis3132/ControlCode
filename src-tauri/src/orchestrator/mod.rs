//! Fase 9 — Mitigación del consumo de contexto del modo orquestador.
//!
//! La Fase 8 dejó a un agente externo manejando la app por la CLI. El problema que abre es
//! que la CLI le devuelve texto de terminal, y el contexto de un modelo es finito: tres
//! tabs leídas un par de veces cada una ya lo llenan. Este módulo agrupa las tres piezas
//! que lo evitan:
//!
//! - [`digest`] — comprime la salida antes de devolverla (señales en vez de transcripción).
//! - [`watch`]  — modo push: las tabs avisan en vez de que el orquestador relea.
//! - [`cursors`] — cada lectura devuelve solo lo NUEVO, así que llamar dos
//!   veces seguidas no vuelve a cobrar lo mismo. Es el "contexto por invocación, no
//!   acumulativo" del plan.
//!
//! Y una cuarta transversal: [`record_response`] contabiliza lo que la CLI se llevó, para
//! que la app pueda mostrárselo al usuario. Sin ese número, el costo del modo orquestador
//! es invisible hasta que el modelo se queda sin contexto.

mod cursors;
pub mod digest;
mod usage;
pub mod watch;
#[cfg(test)]
mod test;

pub use cursors::*;
pub use usage::*;
