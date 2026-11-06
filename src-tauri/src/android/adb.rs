//! Hablar con `adb`: encontrarlo, correrlo con tope de tiempo y leer lo que devuelve.
//!
//! Todo pasa por el binario de la persona, el mismo que usa en su terminal: no se habla el
//! protocolo de adb a mano. Así cualquier dispositivo que ella ya tenga autorizado (USB,
//! Wi-Fi, emuladores) funciona sin configurar nada acá.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::util::output_with_timeout;

/// Lo que se le dice a quien pide algo sin `adb` instalado.
pub const NOT_FOUND: &str = "adb is not installed or Control Code can't find it. Install the Android SDK \
platform-tools (or Android Studio) and make sure `adb` is in the PATH or ANDROID_HOME is set.";

/// Cuánto vale lo que se encontró. Se busca seguido (la vista pide un cuadro varias veces por
/// segundo) y son varios `stat`; pero alguien que instala el SDK con la app abierta tiene que
/// verlo aparecer sin reiniciarla.
const LOCATE_TTL: Duration = Duration::from_secs(20);

static LOCATED: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Las carpetas donde suele quedar el SDK: la de Android Studio en cada sistema y las que
/// nombran las variables de entorno.
fn sdk_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            roots.push(PathBuf::from(root));
        }
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Android").join("Sdk"));
        roots.push(home.join("Library").join("Android").join("sdk"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Android").join("Sdk"));
    }
    roots
}

fn search_adb() -> Option<PathBuf> {
    let name = exe("adb");
    let in_sdk = |root: &Path| Some(root.join("platform-tools").join(&name)).filter(|p| p.is_file());
    // Primero lo que la persona eligió (variables), después su PATH, después las de siempre.
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(found) = std::env::var_os(var).filter(|v| !v.is_empty()).and_then(|r| in_sdk(Path::new(&r))) {
            return Some(found);
        }
    }
    crate::util::path_env::find_program("adb").or_else(|| sdk_roots().iter().find_map(|r| in_sdk(r)))
}

/// La ruta de `adb`, si hay uno.
pub fn locate() -> Option<PathBuf> {
    let mut cached = LOCATED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, found)) = cached.as_ref() {
        if at.elapsed() < LOCATE_TTL {
            return found.clone();
        }
    }
    let found = search_adb();
    *cached = Some((Instant::now(), found.clone()));
    found
}

/// El emulador del SDK (para listar y arrancar AVDs), si está instalado.
pub fn emulator() -> Option<PathBuf> {
    let name = exe("emulator");
    let mut roots = sdk_roots();
    // El SDK de donde salió `adb`, aunque no esté en ninguna de las carpetas conocidas.
    if let Some(sdk) = locate().as_deref().and_then(Path::parent).and_then(Path::parent) {
        roots.insert(0, sdk.to_path_buf());
    }
    roots.iter().map(|r| r.join("emulator").join(&name)).find(|p| p.is_file())
}

/// Corre `adb [-s serial] args…` y devuelve su salida estándar tal cual (puede ser binaria:
/// una captura).
pub fn run(serial: Option<&str>, args: &[&str], limit: Duration) -> Result<Vec<u8>, String> {
    let bin = locate().ok_or_else(|| NOT_FOUND.to_string())?;
    let mut cmd = Command::new(bin);
    if let Some(serial) = serial {
        cmd.args(["-s", serial]);
    }
    cmd.args(args);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            format!("adb {} did not answer within {} s", args.first().copied().unwrap_or(""), limit.as_secs())
        } else {
            format!("Could not run adb: {e}")
        }
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let text = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(if text.is_empty() { format!("adb {} failed", args.join(" ")) } else { text });
    }
    Ok(out.stdout)
}

/// `adb shell <command>` en el dispositivo, como texto. `command` va entero a `sh` del
/// teléfono: quien lo arma escapa lo que haga falta (ver `input::quote`).
pub fn shell(serial: &str, command: &str, limit: Duration) -> Result<String, String> {
    let out = run(Some(serial), &["shell", command], limit)?;
    let text = String::from_utf8_lossy(&out).into_owned();
    // Algunas versiones de Android imprimen la excepción de un comando del sistema (`input`,
    // `am`, `pm`) y salen igual con 0.
    if let Some(at) = text.find("Exception occurred while executing") {
        let detail = text[at..].lines().take(2).collect::<Vec<_>>().join(" ");
        return Err(detail);
    }
    Ok(text)
}

/// Un dispositivo como lo lista `adb devices -l`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial: String,
    /// `device` (listo), `unauthorized`, `offline`, `authorizing`…
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub emulator: bool,
}

impl Device {
    pub fn ready(&self) -> bool {
        self.state == "device"
    }

    /// Cómo nombrarlo: el modelo si se sabe, si no el serial.
    pub fn name(&self) -> String {
        self.model.as_deref().map(|m| m.replace('_', " ")).unwrap_or_else(|| self.serial.clone())
    }
}

/// Lee la salida de `adb devices -l`.
pub fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("List of devices") && !l.starts_with('*'))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let mut model = None;
            let mut product = None;
            for part in parts {
                if let Some(v) = part.strip_prefix("model:") {
                    model = Some(v.to_string());
                } else if let Some(v) = part.strip_prefix("product:") {
                    product = Some(v.to_string());
                }
            }
            let emulator = serial.starts_with("emulator-");
            Some(Device { serial, state, model, product, emulator })
        })
        .collect()
}

pub fn devices() -> Result<Vec<Device>, String> {
    let out = run(None, &["devices", "-l"], Duration::from_secs(10))?;
    Ok(parse_devices(&String::from_utf8_lossy(&out)))
}

static AVDS: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// Los emuladores (AVDs) que se pueden arrancar. Se recuerdan un rato: la vista pregunta
/// cada pocos segundos y cada vez sería lanzar el emulador para que liste.
pub fn avds() -> Vec<String> {
    let mut cached = AVDS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, list)) = cached.as_ref() {
        if at.elapsed() < LOCATE_TTL {
            return list.clone();
        }
    }
    let list = emulator()
        .and_then(|bin| output_with_timeout(Command::new(bin).arg("-list-avds"), Duration::from_secs(10)).ok())
        .map(|out| parse_avds(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default();
    *cached = Some((Instant::now(), list.clone()));
    list
}

/// Las líneas de `emulator -list-avds` que son nombres (el emulador a veces antepone avisos).
pub fn parse_avds(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("INFO") && !l.starts_with("WARNING") && !l.contains(' '))
        .map(str::to_string)
        .collect()
}

/// Arranca un AVD y vuelve enseguida: el emulador sigue solo, en su ventana.
pub fn start_avd(name: &str) -> Result<(), String> {
    if !avds().iter().any(|a| a == name) {
        return Err(format!("There is no emulator called '{name}'."));
    }
    let bin = emulator().ok_or("The Android emulator is not installed.")?;
    let mut cmd = Command::new(bin);
    cmd.args(["-avd", name])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Su propio grupo de procesos: que cerrar la app no se lleve el emulador puesto.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(DETACHED_PROCESS);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the emulator: {e}"))
}

/// Una captura de la pantalla, en PNG.
pub fn screencap(serial: &str) -> Result<Vec<u8>, String> {
    let png = run(Some(serial), &["exec-out", "screencap", "-p"], Duration::from_secs(15))?;
    if png_size(&png).is_none() {
        let text = String::from_utf8_lossy(&png[..png.len().min(200)]).trim().to_string();
        return Err(if text.is_empty() { "The device returned an empty screenshot.".into() } else { text });
    }
    Ok(png)
}

/// El ancho y alto de un PNG, leídos de su cabecera.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((width, height))
}
