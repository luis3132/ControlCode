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

use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};

use super::parse::parse_usage_screen;
use super::trust::{pick_trusted, trusted_paths};

/// Cuánto se espera a que el panel termine de dibujarse antes de rendirse.
const TIMEOUT: Duration = Duration::from_secs(25);

/// Cuánto se le da a la TUI para arrancar antes de mandarle el comando. Menos que esto y
/// el `/usage` se escribe mientras todavía está montando la pantalla, y se pierde.
const SETTLE: Duration = Duration::from_millis(2500);


/// Lo último que respondió cada cuenta, en memoria. Vive en el backend y no en la ventana:
/// así dos ventanas abiertas comparten la misma respuesta en vez de preguntar cada una por
/// su lado. La copia de SQLite es la que sobrevive al cierre de la app.
static CACHE: LazyLock<Mutex<HashMap<String, LiveUsage>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Dónde se guarda, para que al abrir la app el panel muestre lo último sabido en vez de
/// una barra vacía mientras se levanta la TUI.
fn stored_key(account_key: &str) -> String {
    format!("usage.live.{account_key}")
}


/// Una de las barras del panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// Del 0 al 100, tal como lo informa la TUI.
    pub percent: u8,
    /// Cuándo se reinicia, con el texto que muestra la TUI (incluye su zona horaria).
    pub resets: Option<String>,
}

/// La semana de un modelo concreto, cuando el plan lo mide aparte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeter {
    pub model: String,
    pub meter: Meter,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveUsage {
    /// `false` = no se pudo preguntar (no está instalada, tardó demasiado, pidió confiar
    /// en la carpeta, o cambió el formato del panel).
    pub available: bool,
    /// La ventana corta, la que se reinicia cada pocas horas.
    pub session: Option<Meter>,
    /// La semana, sumando todos los modelos.
    pub week: Option<Meter>,
    /// Las semanas que el plan mide por modelo (Fable, por ejemplo).
    pub week_models: Vec<ModelMeter>,
    /// Cuándo se preguntó de verdad, en epoch de segundos. Es lo que le permite a la UI
    /// decir "actualizado hace tanto" en vez de dar a entender que el dato es de ahora.
    pub fetched_at: i64,
    /// `true` = salió de la caché, no se volvió a preguntar.
    pub cached: bool,
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
        // Con la semana dibujada ya está todo lo que interesa: el panel pinta primero la
        // ventana en curso y después la semana.
        if sent && text.contains("Current week") && text.contains("Resets") {
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
    // `account_key`: con qué cuenta se preguntó. Es la clave de la caché.
    account_key: String,
    cwd: String,
    env: HashMap<String, String>,
    // `force`: volver a preguntar aunque haya algo guardado. Es el botón de refrescar.
    force: bool,
    db: tauri::State<'_, DbConnection>,
) -> Result<LiveUsage, String> {
    // Sin `force` se devuelve lo guardado TAL CUAL, viejo o no. Quien decide si hace falta
    // volver a preguntar es la UI, que para eso recibe `fetchedAt`: así al abrir la app el
    // panel muestra el último dato al instante y se actualiza después, en vez de dejar al
    // usuario mirando un hueco mientras arranca la TUI.
    if !force {
        if let Ok(cache) = CACHE.lock() {
            if let Some(hit) = cache.get(&account_key) {
                return Ok(LiveUsage { cached: true, ..hit.clone() });
            }
        }
        if let Ok(Some(raw)) = crate::database::get_setting(&db, &stored_key(&account_key)) {
            if let Ok(stored) = serde_json::from_str::<LiveUsage>(&raw) {
                if let Ok(mut cache) = CACHE.lock() {
                    cache.insert(account_key.clone(), stored.clone());
                }
                return Ok(LiveUsage { cached: true, ..stored });
            }
        }
    }

    let Some(command) = crate::agents::agent_command("claude-code") else {
        return Ok(LiveUsage::failed("No se conoce el comando de Claude Code"));
    };
    if !crate::agents::command_exists(command) {
        return Ok(LiveUsage::failed("Claude Code no está instalado"));
    }

    // La carpeta la decide LA CUENTA, no quien llama: cada perfil lleva su propia lista de
    // carpetas de confianza, y abrir el sondeo fuera de ella deja a la TUI esperando una
    // confirmación que nadie puede darle desde acá.
    let config_dir = env
        .get("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")));
    let Some(config_dir) = config_dir else {
        return Ok(LiveUsage::failed("No se pudo resolver la carpeta de la cuenta"));
    };

    let trusted = std::fs::read_to_string(config_dir.join(".claude.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(|json| trusted_paths(&json))
        .unwrap_or_default();

    let Some(cwd) = pick_trusted(&trusted, Some(cwd.as_str()), |p| std::path::Path::new(p).is_dir())
        .map(str::to_string)
    else {
        return Ok(LiveUsage::failed(
            "Esta cuenta todavía no confía en ninguna carpeta. Abrí un agente con ella una vez y aceptá el aviso.",
        ));
    };

    let env: Vec<(String, String)> = env.into_iter().collect();
    let fresh = tauri::async_runtime::spawn_blocking(move || match capture(command, &cwd, &env) {
        Ok(screen) => parse_usage_screen(&screen),
        Err(problem) => LiveUsage::failed(problem),
    })
    .await
    .map_err(|e| e.to_string())?;

    let fresh = LiveUsage { fetched_at: crate::util::now_ts(), cached: false, ..fresh };

    // Un fallo NO se guarda: puede ser pasajero (la TUI todavía no estaba, la carpeta se
    // acaba de confiar), y cachearlo dejaría el panel roto cinco minutos sin motivo.
    if fresh.available {
        if let Ok(mut cache) = CACHE.lock() {
            cache.insert(account_key.clone(), fresh.clone());
        }
        if let Ok(raw) = serde_json::to_string(&fresh) {
            let _ = crate::database::set_setting(&db, &stored_key(&account_key), &raw);
        }
    }
    Ok(fresh)
}
