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

use crate::terminal::containment::ProcessGroup;

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};

use super::parse::parse_usage_screen;
use super::trust::{config_file, probe_dir, trust_dir};

/// Cuánto se espera a que el panel termine de dibujarse antes de rendirse.
const TIMEOUT: Duration = Duration::from_secs(25);

/// Cuánto se le da a la TUI para arrancar antes de mandarle el comando. Menos que esto y
/// el `/usage` se escribe mientras todavía está montando la pantalla, y se pierde.
const SETTLE: Duration = Duration::from_millis(2500);

/// Cuánto tiene que estar quieta la salida para dar el panel por terminado.
///
/// El panel NO llega de una: primero pinta la ventana y la semana, y un momento después
/// repinta con la semana por modelo (mientras tanto dice «Refreshing…»). Cortar en la
/// primera pintada —que es lo que se hacía— dejaba afuera esa barra.
const QUIET: Duration = Duration::from_millis(700);


/// Lo último que respondió cada cuenta, en memoria. Vive en el backend y no en la ventana:
/// así dos ventanas abiertas comparten la misma respuesta en vez de preguntar cada una por
/// su lado. La copia de SQLite es la que sobrevive al cierre de la app.
static CACHE: LazyLock<Mutex<HashMap<String, LiveUsage>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Dónde se guarda, para que al abrir la app el panel muestre lo último sabido en vez de
/// una barra vacía mientras se levanta la TUI.
///
/// La `v2` no es decorativa: lo guardado por la versión anterior se leyó con el parseo que
/// confundía la semana con la barra de un modelo. Cambiar la clave lo deja atrás en vez de
/// mostrar ese número hasta que se refresque.
fn stored_key(account_key: &str) -> String {
    format!("usage.live.v2.{account_key}")
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

/// La sesión de la cuenta venció o nunca se inició: se dice eso, en vez de esperar un panel
/// que no va a salir y terminar en un «no llegó a tiempo» que no explica nada.
pub(super) fn capture_problem(raw: &str) -> Option<&'static str> {
    let screen = super::screen::render(raw).to_lowercase();
    if screen.contains("oauth session expired") || screen.contains("oauth token expired") {
        Some("accounts.auth.expired")
    } else if screen.contains("not logged in")
        || screen.contains("please run /login")
        || screen.contains("failed to authenticate")
    {
        Some("accounts.auth.required")
    } else {
        None
    }
}

/// Abre `claude` en una PTY, le manda `/usage` y devuelve lo que dibujó.
///
/// No es privada para poder probarla contra la TUI instalada (ver `contra_la_tui_de_verdad`).
pub(super) fn capture(command: &str, cwd: &str, env: &[(String, String)]) -> Result<String, String> {
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: super::screen::ROWS as u16,
            cols: super::screen::COLS as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
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

    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    // El grupo es el de las tabs: al cortar el sondeo mueren el `claude` y lo que haya
    // lanzado (sus servidores MCP), no solo el hijo directo. El `Drop` cubre los `?`.
    let mut probe = UsageProbe::new(child);

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
    let mut last_data = Instant::now();

    let result = loop {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            raw.extend_from_slice(&chunk);
            last_data = Instant::now();
        }
        let text = String::from_utf8_lossy(&raw);

        if let Some(problem) = capture_problem(&text) {
            break Err(problem.to_string());
        }

        // La carpeta no está entre las de confianza y la TUI está esperando una respuesta.
        // No se contesta por el usuario: se corta y se dice. Se mira sin espacios: la TUI
        // arma las columnas moviendo el cursor, así que en crudo viene como
        // «Isthisaprojectyoucreated», y con espacios el sondeo esperaba hasta vencer.
        let squeezed: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if squeezed.contains("Isthisaprojectyoucreated") || squeezed.contains("trustthisfolder") {
            break Err("accounts.plan.problem.trustRequired".to_string());
        }

        if !sent && start.elapsed() > SETTLE {
            let _ = writer.write_all(b"/usage\r");
            let _ = writer.flush();
            sent = true;
        }

        // El rótulo se busca sin espacios: la TUI arma las columnas moviendo el cursor, así
        // que en el flujo crudo «Current session» puede venir todo junto (ver `screen.rs`).
        let panel = sent && text.contains("Current");

        // Se corta cuando el panel ya tiene todo, y si no, cuando deja de escribir: son
        // segundos de diferencia y esto corre con el usuario esperando.
        if panel && (complete(&text) || last_data.elapsed() >= QUIET) {
            break Ok(text.into_owned());
        }
        if start.elapsed() > TIMEOUT {
            // Con el panel dibujado se devuelve igual: que el desglose de abajo tarde
            // demasiado no es motivo para tirar los porcentajes que ya están.
            break if panel {
                Ok(text.into_owned())
            } else if sent {
                Err("accounts.plan.problem.timeout".to_string())
            } else {
                Err("accounts.plan.problem.startup".to_string())
            };
        }
    };

    // Para cuando cambie el panel de la TUI y el parseo deje de encontrarlo: con
    // `CC_USAGE_DUMP=<archivo>` se guarda lo crudo que se vio.
    if let Ok(path) = std::env::var("CC_USAGE_DUMP") {
        let _ = std::fs::write(path, &raw);
    }

    probe.release();
    result
}

/// El hijo de `/usage` y todo lo que haya alcanzado a lanzar.
struct UsageProbe {
    group: ProcessGroup,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    released: bool,
}

impl UsageProbe {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        let mut group = ProcessGroup::new(0);
        group.adopt(&*child);
        Self { group, child, released: false }
    }

    fn release(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        release_usage_process(&mut self.group, &mut *self.child);
    }
}

impl Drop for UsageProbe {
    fn drop(&mut self) {
        self.release();
    }
}

/// Mata el grupo entero y recién después al hijo directo.
pub(super) fn release_usage_process(
    group: &mut ProcessGroup,
    child: &mut (dyn portable_pty::Child + Send + Sync),
) {
    group.kill_all();
    let _ = child.kill();
    let _ = child.wait();
}

/// ¿Ya está todo lo que interesa?
///
/// Las tres barras dibujadas y sin «Refreshing…», que es lo que la TUI muestra mientras le
/// falta una. Con eso se corta al toque; un plan que no mida modelos aparte nunca cumple
/// esto y termina cortando por silencio, que es lo mismo unos cientos de milisegundos
/// después.
fn complete(text: &str) -> bool {
    let screen = super::screen::render(text);
    let lines: Vec<&str> = screen.lines().map(str::trim).collect();
    let has = |label: &str| lines.iter().any(|l| l.starts_with(label));
    let per_model = lines
        .iter()
        .any(|l| l.starts_with("Current week (") && !l.contains("(all models)"));

    has("Current session") && has("Current week (all models)") && per_model && !screen.contains("Refreshing")
}

/// El consumo del plan de una cuenta, preguntado en vivo.
#[tauri::command]
pub async fn claude_live_usage(
    // `account_key`: con qué cuenta se preguntó. Es la clave de la caché.
    account_key: String,
    env: HashMap<String, String>,
    // `force`: volver a preguntar aunque haya algo guardado. Es el botón de refrescar.
    force: bool,
    // `cacheOnly`: devolver lo guardado o nada, sin levantar la TUI. Es lo de arrancar la
    // app, para llenar la barra sin un proceso por cuenta.
    cache_only: Option<bool>,
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

    // Nada guardado: vacío y sin problema (`fetchedAt` 0), que no es lo mismo que un fallo.
    if cache_only == Some(true) {
        return Ok(LiveUsage::default());
    }

    let Some(command) = crate::agents::agent_command("claude-code") else {
        return Ok(LiveUsage::failed("accounts.plan.problem.commandUnknown"));
    };
    if !crate::agents::command_exists(command) {
        return Ok(LiveUsage::failed("accounts.plan.problem.notInstalled"));
    }

    // El sondeo se abre SIEMPRE en la misma carpeta: una vacía de la app, que la app
    // pre-aprueba en la config de esta cuenta antes de arrancar. Ver `trust.rs`: dependía
    // de encontrar alguna carpeta que la cuenta ya hubiera aceptado, y una cuenta nueva no
    // tiene ninguna.
    let Some(config_path) = config_file(env.get("CLAUDE_CONFIG_DIR").map(String::as_str)) else {
        return Ok(LiveUsage::failed("accounts.plan.problem.configUnavailable"));
    };
    let cwd = match probe_dir() {
        Ok(dir) => dir,
        Err(problem) => return Ok(LiveUsage::failed(problem)),
    };
    let Some(cwd) = cwd.to_str().map(str::to_string) else {
        return Ok(LiveUsage::failed("accounts.plan.problem.probePath"));
    };
    if let Err(problem) = trust_dir(&config_path, &cwd) {
        return Ok(LiveUsage::failed(problem));
    }

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
