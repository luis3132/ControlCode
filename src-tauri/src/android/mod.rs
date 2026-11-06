//! Android: ver y usar un dispositivo (o un emulador) por `adb`, la persona desde la vista
//! "Dispositivo" y los agentes con las tools `android_*`.
//!
//! - `adb`: encontrar el binario, correrlo con tope de tiempo, dispositivos y emuladores.
//! - `ui`: la pantalla por accesibilidad (`uiautomator dump`) en una línea por elemento.
//! - `input`: teclas por nombre y texto escapado para `input`.
//! - `agent`: lo que pide cada tool, con el estado que comparten (refs, quién usa qué).
//! - `commands`: lo que usa la vista.
//!
//! Sin `adb` instalado no aparece nada: ni la vista ni las tools.

pub mod adb;
pub mod agent;
pub mod commands;
pub mod input;
pub mod ui;

#[cfg(test)]
mod test;
