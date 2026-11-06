//! Android: ver y usar un dispositivo (o un emulador) por `adb`, la persona desde la vista
//! "Dispositivo" y los agentes con las tools `android_*`.
//!
//! - `adb`: encontrar el binario, correrlo con tope de tiempo, dispositivos y emuladores.
//! - `ui`: la pantalla por accesibilidad (`uiautomator dump`) en una línea por elemento.
//! - `input`: teclas por nombre y texto escapado para `input`.
//! - `agent`: lo que pide cada tool, con el estado que comparten (refs, quién usa qué).
//! - `h264`: el video de `screenrecord` cortado en cuadros que la vista decodifica.
//! - `stream`: la pantalla en video (`screenrecord`), servida a la vista por un socket local.
//! - `pointer`: la entrada de la persona, en vivo, por un `adb shell` que queda abierto.
//! - `commands`: lo que usa la vista.
//!
//! Sin `adb` instalado no aparece nada: ni la vista ni las tools.

pub mod adb;
pub mod agent;
pub mod commands;
pub mod h264;
pub mod input;
pub mod pointer;
pub mod stream;
pub mod ui;

#[cfg(test)]
mod test;
