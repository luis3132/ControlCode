//! Cuánto consumió de verdad una cuenta, leído de los transcripts de la TUI.
//!
//! No hay API para preguntarle a nadie cuánto llevás gastado, así que el único dato real
//! disponible es el que la propia TUI escribe en disco al conversar. Claude Code guarda,
//! en cada mensaje del asistente, el `usage` exacto que le devolvió la API — tokens de
//! entrada, de salida y de caché. Sumarlos es el consumo real, no una estimación.
//!
//! Lo que NO se puede saber por acá es la cuota del plan (cuánto queda de la ventana de 5
//! horas): eso no está en el transcript ni en ningún archivo local. Se informa el consumo,
//! no el porcentaje restante — inventarlo sería peor que no mostrarlo.

mod claude;
mod live;
mod parse;
mod trust;
mod types;
#[cfg(test)]
mod test;

pub use claude::*;
pub use live::*;
