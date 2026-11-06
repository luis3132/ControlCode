//! Los comandos de la vista "Dispositivo": ver la pantalla y usarla con el mouse y el teclado.
//!
//! Todos corren fuera del hilo principal (`spawn_blocking`): cada uno lanza `adb`, que
//! tarda de decenas a cientos de milisegundos, y en Linux ese hilo es el que dibuja.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::adb::{self, Device};
use super::agent;
use super::input;

async fn off_main<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidStatus {
    /// Dónde está `adb`; `None` = no hay, y la vista no se ofrece.
    pub adb: Option<String>,
    pub devices: Vec<Device>,
    /// Los AVDs que se pueden arrancar.
    pub avds: Vec<String>,
}

/// Si hay `adb` y, con `devices`, qué dispositivos hay y qué emuladores se pueden arrancar.
///
/// Sin `devices` solo mira el disco: listar dispositivos levanta el daemon de adb, y eso no
/// tiene que pasar por abrir la app, solo por abrir la vista.
#[tauri::command]
pub async fn android_status(devices: bool) -> Result<AndroidStatus, String> {
    off_main(move || {
        let Some(path) = adb::locate() else {
            return Ok(AndroidStatus { adb: None, devices: Vec::new(), avds: Vec::new() });
        };
        Ok(AndroidStatus {
            adb: Some(path.to_string_lossy().into_owned()),
            devices: if devices { adb::devices().unwrap_or_default() } else { Vec::new() },
            avds: if devices { adb::avds() } else { Vec::new() },
        })
    })
    .await
}

/// Un cuadro de la pantalla, en PNG, como bytes crudos: sin pasar por JSON ni base64.
#[tauri::command]
pub async fn android_frame(serial: String) -> Result<tauri::ipc::Response, String> {
    off_main(move || adb::screencap(&serial).map(tauri::ipc::Response::new)).await
}

/// Lo que hace la persona sobre la pantalla, en píxeles del dispositivo.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UserInput {
    Tap { x: i32, y: i32 },
    Hold { x: i32, y: i32, ms: u32 },
    Swipe { x: i32, y: i32, x2: i32, y2: i32, ms: u32 },
    Key { key: String },
    Text { text: String },
}

/// El comando `input` que hace eso.
pub fn input_command(action: &UserInput) -> Result<String, String> {
    Ok(match action {
        UserInput::Tap { x, y } => format!("input tap {x} {y}"),
        UserInput::Hold { x, y, ms } => format!("input swipe {x} {y} {x} {y} {}", ms.clamp(&100, &10_000)),
        UserInput::Swipe { x, y, x2, y2, ms } => format!("input swipe {x} {y} {x2} {y2} {}", ms.clamp(&30, &5000)),
        UserInput::Key { key } => {
            let code = input::keycode(key).ok_or_else(|| format!("Tecla desconocida: {key}"))?;
            format!("input keyevent {code}")
        }
        UserInput::Text { text } => {
            let skipped = input::untypeable(text);
            let typeable: String = text.chars().filter(|c| !skipped.contains(c)).collect();
            let steps: Vec<String> = input::type_steps(&typeable)
                .into_iter()
                .map(|step| match step {
                    input::TypeStep::Text(chunk) => format!("input text {}", input::quote(&chunk)),
                    input::TypeStep::Key(code) => format!("input keyevent {code}"),
                })
                .collect();
            if steps.is_empty() {
                return Err("Ese texto no se puede escribir por adb (acentos, ñ y emojis no pasan).".into());
            }
            steps.join(" && ")
        }
    })
}

#[tauri::command]
pub async fn android_input(serial: String, action: UserInput) -> Result<(), String> {
    off_main(move || {
        agent::note_user_touch(&serial);
        let command = input_command(&action)?;
        adb::shell(&serial, &command, Duration::from_secs(15)).map(|_| ())
    })
    .await
}

/// La persona eligió qué dispositivo mirar: es el que usan los agentes cuando hay varios y
/// no dicen cuál.
#[tauri::command]
pub async fn android_select(serial: Option<String>) -> Result<(), String> {
    agent::set_preferred(serial);
    Ok(())
}

#[tauri::command]
pub async fn android_start_avd(name: String) -> Result<(), String> {
    off_main(move || adb::start_avd(&name)).await
}
