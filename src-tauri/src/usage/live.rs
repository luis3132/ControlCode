//! El consumo del PLAN, preguntado a la propia TUI.
//!
//! El porcentaje de cupo no está en ningún archivo: Claude Code se lo pide a la API cuando
//! corrés `/usage` y no lo guarda. Pero `/usage` lo resuelve el CLIENTE, no el modelo —
//! así que se le puede preguntar sin gastar tokens y sin adivinar ningún endpoint interno:
//! se abre `claude` en una PTY (algo que esta app ya hace para cada tab), se le manda el
//! comando y se lee lo que dibuja.
//!
//! Es lectura de pantalla, con lo que eso implica: si cambia el formato de ese panel, el
//! parseo deja de encontrar los números. Por eso devuelve `available: false` en vez de
//! ceros, y por eso el parser vive separado y con los tests hechos sobre una captura real.

use std::io::Read;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;

use super::parse::parse_usage_screen;

/// Cuánto se espera a que el panel termine de dibujarse antes de rendirse.
const TIMEOUT: Duration = Duration::from_secs(25);

/// Cuánto se le da a la TUI para arrancar antes de mandarle el comando. Menos que esto y
/// el `/usage` se escribe mientras todavía está montando la pantalla, y se pierde.
const SETTLE: Duration = Duration::from_millis(2500);

/// Una de las barras del panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// Del 0 al 100, tal como lo informa la TUI.
    pub percent: u8,
    /// Cuándo se reinicia, con el texto que muestra la TUI (incluye su zona horaria).
    pub resets: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUsage {
    /// `false` = no se pudo preguntar (no está instalada, tardó demasiado, pidió confiar
    /// en la carpeta, o cambió el formato del panel).
    pub available: bool,
    /// La ventana corta, la que se reinicia cada pocas horas.
    pub session: Option<Meter>,
    /// La semana, sumando todos los modelos.
    pub week: Option<Meter>,
    /// La semana de un modelo en particular, cuando el plan lo mide aparte.
    pub week_model: Option<String>,
    pub week_model_meter: Option<Meter>,
    /// Por qué no se pudo, para poder decirlo en vez de mostrar un panel vacío.
    pub problem: Option<String>,
}

impl LiveUsage {
    fn failed(reason: impl Into<String>) -> Self {
        LiveUsage { problem: Some(reason.into()), ..Default::default() }
    }
}

/// Abre `claude` en una PTY, le manda `/usage` y devuelve lo que dibujó.
fn capture(command: &str, cwd: &str, env: &[(String, String)]) -> Result<String, String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows: 45, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(command);
    cmd.cwd(cwd);
    // Sin esto la TUI se dibuja en modo tonto y el panel no sale.
    cmd.env("TERM", "xterm-256color");
    // Que esta sesión de sondeo NO deje transcript: si no, cada vez que se mira el
    // consumo aparecería una conversación vacía en el historial del usuario.
    cmd.env("CLAUDE_CODE_CHILD_SESSION", "1");
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;

    // El lector va en su propio hilo: `read` bloquea, y hace falta poder rendirse por
    // tiempo aunque la TUI no escriba nada más.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let start = Instant::now();
    let mut raw = Vec::new();
    let mut sent = false;

    let result = loop {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            raw.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&raw);

        // La carpeta no está entre las de confianza y la TUI está esperando una respuesta.
        // No se contesta por el usuario: se corta y se dice.
        if text.contains("Is this a project you created") || text.contains("trust this folder") {
            break Err("La TUI pidió confirmar que confiás en la carpeta".to_string());
        }

        if !sent && start.elapsed() > SETTLE {
            let _ = writer.write_all(b"/usage\r");
            let _ = writer.flush();
            sent = true;
        }

        // Se corta apenas el panel está completo, no al vencer el tiempo: son segundos de
        // diferencia y esto corre con el usuario esperando.
        if sent && text.matches("% used").count() >= 2 && text.contains("Resets") {
            break Ok(text.into_owned());
        }
        if start.elapsed() > TIMEOUT {
            break if sent {
                Err("La TUI no mostró el panel de consumo a tiempo".to_string())
            } else {
                Err("La TUI no llegó a arrancar".to_string())
            };
        }
    };

    let _ = child.kill();
    let _ = child.wait();
    result
}

/// El consumo del plan de una cuenta, preguntado en vivo.
#[tauri::command]
pub async fn claude_live_usage(
    cwd: String,
    env: std::collections::HashMap<String, String>,
) -> Result<LiveUsage, String> {
    let Some(command) = crate::agents::agent_command("claude-code") else {
        return Ok(LiveUsage::failed("No se conoce el comando de Claude Code"));
    };
    if !crate::agents::command_exists(command) {
        return Ok(LiveUsage::failed("Claude Code no está instalado"));
    }

    let env: Vec<(String, String)> = env.into_iter().collect();
    tauri::async_runtime::spawn_blocking(move || match capture(command, &cwd, &env) {
        Ok(screen) => parse_usage_screen(&screen),
        Err(problem) => LiveUsage::failed(problem),
    })
    .await
    .map_err(|e| e.to_string())
}
