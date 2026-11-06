//! Lo que pide un agente con las tools `android_*`: leer la pantalla y usarla como una
//! persona (tocar, deslizar, escribir, apretar teclas), además de lo que una persona haría
//! desde la computadora (abrir apps, leer logcat, instalar).
//!
//! Corre entero en el backend: a diferencia del navegador, el dispositivo no vive en la
//! ventana. La ventana solo se entera después, para dibujar el toque con el color del
//! agente y refrescar la imagen (ver `ipc::commands::android`).

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::adb::{self, Device};
use super::input::{self, TypeStep};
use super::ui::{self, Target, UiNode};

/// Un gesto sobre el dispositivo, para dibujarlo en la vista con el color de quien lo hizo.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Touch {
    pub serial: String,
    /// `tap`, `hold`, `swipe`, `key` o `text`.
    pub kind: &'static str,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub x2: Option<i32>,
    pub y2: Option<i32>,
    /// La tecla o el texto, para mostrarlo.
    pub label: Option<String>,
}

impl Touch {
    fn at(serial: &str, kind: &'static str, x: i32, y: i32) -> Self {
        Touch { serial: serial.into(), kind, x: Some(x), y: Some(y), x2: None, y2: None, label: None }
    }
}

/// Lo que vuelve una operación.
#[derive(Debug, Default)]
pub struct Outcome {
    pub text: String,
    /// Una imagen en base64 y su tipo, para `android_screenshot`.
    pub image: Option<(String, &'static str)>,
    /// El dispositivo sobre el que actuó.
    pub serial: Option<String>,
    pub touches: Vec<Touch>,
}

impl Outcome {
    fn text(serial: Option<&str>, text: impl Into<String>) -> Self {
        Outcome { text: text.into(), serial: serial.map(str::to_string), ..Outcome::default() }
    }
}

// ── Estado compartido ──────────────────────────────────────────

/// Los refs del último snapshot de cada dispositivo.
static TARGETS: Mutex<Option<HashMap<String, Vec<Target>>>> = Mutex::new(None);
/// El dispositivo que usó cada agente la última vez: con varios conectados, sigue con ese.
static LAST_USED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// El dispositivo que la persona está mirando en su vista.
static PREFERRED: Mutex<Option<String>> = Mutex::new(None);
/// Cuándo tocó la persona cada dispositivo por última vez.
static USER_TOUCH: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
/// `uiautomator` no admite dos volcados a la vez: el segundo falla.
static DUMPING: Mutex<()> = Mutex::new(());

fn with_map<K, V, R>(cell: &Mutex<Option<HashMap<K, V>>>, f: impl FnOnce(&mut HashMap<K, V>) -> R) -> R {
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// La vista eligió este dispositivo (o ninguno).
pub fn set_preferred(serial: Option<String>) {
    *PREFERRED.lock().unwrap_or_else(|e| e.into_inner()) = serial;
}

/// La persona acaba de tocar este dispositivo desde la vista.
pub fn note_user_touch(serial: &str) {
    with_map(&USER_TOUCH, |m| m.insert(serial.to_string(), Instant::now()));
}

/// Cuánto hace que la persona tocó el dispositivo, si fue hace poco.
fn user_touched_recently(serial: &str) -> Option<Duration> {
    with_map(&USER_TOUCH, |m| m.get(serial).map(Instant::elapsed)).filter(|d| *d < Duration::from_secs(4))
}

// ── Pedido ─────────────────────────────────────────────────────

fn s<'a>(r: &'a Value, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn n(r: &Value, key: &str) -> Option<f64> {
    r.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())).filter(|v| v.is_finite())
}

fn b(r: &Value, key: &str) -> bool {
    r.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// El dispositivo sobre el que actuar.
///
/// Con uno solo conectado, ese. Con varios: el que se pidió, o el que este agente venía
/// usando, o el que la persona tiene en su vista. Si no se puede saber, se lo pregunta en vez
/// de adivinar: tocar el teléfono equivocado no se deshace.
fn pick(request: &Value, actor: &str) -> Result<Device, String> {
    let all = adb::devices()?;
    let ready: Vec<&Device> = all.iter().filter(|d| d.ready()).collect();
    let chosen = if let Some(wanted) = s(request, "device") {
        let wanted_lower = wanted.to_lowercase();
        let found = all.iter().find(|d| d.serial == wanted).or_else(|| {
            all.iter().find(|d| {
                d.model.as_deref().is_some_and(|m| m.to_lowercase() == wanted_lower.replace(' ', "_"))
                    || d.name().to_lowercase() == wanted_lower
            })
        });
        found.ok_or_else(|| format!("There is no device '{wanted}'. {}", describe_devices(&all)))?
    } else if ready.len() == 1 {
        ready[0]
    } else if ready.is_empty() {
        return Err(no_ready_device(&all));
    } else {
        let last = with_map(&LAST_USED, |m| m.get(actor).cloned());
        let preferred = PREFERRED.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let found = [last, preferred]
            .into_iter()
            .flatten()
            .find_map(|serial| ready.iter().find(|d| d.serial == serial).copied());
        found.ok_or_else(|| format!("Several devices are connected; say which one with `device`. {}", describe_devices(&all)))?
    };
    if !chosen.ready() {
        return Err(format!("{} is {}. {}", chosen.name(), chosen.state, state_hint(&chosen.state)));
    }
    with_map(&LAST_USED, |m| m.insert(actor.to_string(), chosen.serial.clone()));
    Ok(chosen.clone())
}

fn state_hint(state: &str) -> &'static str {
    match state {
        "unauthorized" => "Ask the user to accept the USB debugging prompt on the phone.",
        "offline" => "Reconnect it or restart adb.",
        _ => "",
    }
}

fn no_ready_device(all: &[Device]) -> String {
    if all.is_empty() {
        let avds = adb::avds();
        if avds.is_empty() {
            "No Android device is connected. Ask the user to plug one in with USB debugging on.".into()
        } else {
            format!(
                "No Android device is connected. Start an emulator with android_emulator (available: {}), or ask the \
user to plug in a phone.",
                avds.join(", ")
            )
        }
    } else {
        format!("No device is ready. {}", describe_devices(all))
    }
}

fn describe_devices(all: &[Device]) -> String {
    if all.is_empty() {
        return "No devices are connected.".into();
    }
    let list: Vec<String> = all
        .iter()
        .map(|d| format!("{} ({}{})", d.serial, d.name(), if d.ready() { String::new() } else { format!(", {}", d.state) }))
        .collect();
    format!("Devices: {}.", list.join(", "))
}

// ── Lectura de la pantalla ─────────────────────────────────────

/// Vuelca la pantalla por accesibilidad.
pub fn dump(serial: &str) -> Result<Vec<UiNode>, String> {
    let _one_at_a_time = DUMPING.lock().unwrap_or_else(|e| e.into_inner());
    let limit = Duration::from_secs(25);
    // Directo a la salida: sin escribir en el teléfono. No todas las versiones lo aceptan.
    let direct = adb::run(Some(serial), &["exec-out", "uiautomator", "dump", "--compressed", "/dev/tty"], limit)
        .map(|out| String::from_utf8_lossy(&out).into_owned());
    let xml = match direct {
        Ok(text) if text.contains("<hierarchy") => text,
        _ => adb::shell(
            serial,
            "uiautomator dump --compressed /data/local/tmp/cc_ui.xml >/dev/null && cat /data/local/tmp/cc_ui.xml",
            limit,
        )?,
    };
    let start = xml.find("<?xml").or_else(|| xml.find("<hierarchy")).unwrap_or(0);
    let end = xml.rfind("</hierarchy>").map_or(xml.len(), |i| i + "</hierarchy>".len());
    ui::parse(&xml[start..end]).map_err(|e| {
        if xml.contains("idle state") {
            "The screen never settled (an animation or a video is playing), so it can't be read by accessibility. \
Use android_screenshot instead."
                .into()
        } else {
            e
        }
    })
}

fn snapshot(serial: &str, device: &Device) -> Result<Outcome, String> {
    let nodes = dump(serial)?;
    let (text, targets) = ui::render(&nodes);
    let size = adb::shell(serial, "wm size", Duration::from_secs(5)).ok().and_then(|o| screen_size(&o));
    let package = ui::foreground_package(&nodes).unwrap_or("?");
    let mut out = format!(
        "{} ({serial}) — app {package}{}\n",
        device.name(),
        size.map(|(w, h)| format!(", screen {w}x{h}")).unwrap_or_default()
    );
    if targets.is_empty() {
        out.push_str(
            "The accessibility tree is empty: this screen draws its own UI (a game, Flutter without semantics, a \
video, a WebView not exposed). Use android_screenshot to see it and tap by coordinates.",
        );
    } else {
        out.push_str(&text);
        out.push_str("\n\nAct with the refs (android_tap ref=\"a3\"), or by coordinates (the @x,y center of each element).");
    }
    with_map(&TARGETS, |m| m.insert(serial.to_string(), targets));
    Ok(Outcome::text(Some(serial), out))
}

/// `Physical size: 1080x2400` (y `Override size:` si la persona cambió la escala).
fn screen_size(wm: &str) -> Option<(u32, u32)> {
    let line = wm.lines().rev().find(|l| l.contains("size:"))?;
    let (w, h) = line.rsplit(':').next()?.trim().split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

fn screenshot(serial: &str, request: &Value) -> Result<Outcome, String> {
    let png = adb::screencap(serial)?;
    let (width, height) = adb::png_size(&png).unwrap_or((0, 0));
    let max = n(request, "max").map_or(1280, |m| m.clamp(320.0, 2000.0) as u32);
    let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .map_err(|e| format!("Could not read the screenshot: {e}"))?;
    let scale = (f64::from(max) / f64::from(width.max(height).max(1))).min(1.0);
    let small = if scale < 1.0 {
        image.resize(
            (f64::from(width) * scale).round() as u32,
            (f64::from(height) * scale).round() as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let mut jpeg = Vec::new();
    small
        .to_rgb8()
        .write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    let text = if scale < 1.0 {
        format!(
            "Screen {width}x{height}, shown at {}x{}. Tools take device pixels: multiply what you measure on this \
image by {:.3}.",
            small.width(),
            small.height(),
            1.0 / scale
        )
    } else {
        format!("Screen {width}x{height}. Tools take these same pixel coordinates.")
    };
    Ok(Outcome {
        text,
        image: Some((base64::engine::general_purpose::STANDARD.encode(jpeg), "image/jpeg")),
        serial: Some(serial.to_string()),
        touches: Vec::new(),
    })
}

/// Dónde actuar: un ref del último snapshot, un texto (busca en la pantalla de ahora) o
/// coordenadas. Devuelve los límites del elemento (o un punto) y cómo nombrarlo.
fn locate(serial: &str, request: &Value) -> Result<Option<([i32; 4], String)>, String> {
    if let Some(reference) = s(request, "ref") {
        let reference = reference.trim_start_matches('[').trim_end_matches(']');
        let found = with_map(&TARGETS, |m| m.get(serial).and_then(|t| t.iter().find(|t| t.reference == reference).cloned()));
        let target = found.ok_or_else(|| {
            format!("There is no element {reference} in the last snapshot of this device. Take a new android_snapshot.")
        })?;
        let name = if target.label.is_empty() { reference.to_string() } else { format!("{reference} \"{}\"", target.label) };
        return Ok(Some((target.bounds, name)));
    }
    if let Some(text) = s(request, "text").or_else(|| s(request, "target")) {
        let nodes = dump(serial)?;
        let node = ui::find_text(&nodes, text)
            .ok_or_else(|| format!("Nothing on screen says \"{text}\". Take an android_snapshot to see what is there."))?;
        return Ok(Some((node.bounds, format!("\"{}\"", if node.text.is_empty() { &node.desc } else { &node.text }))));
    }
    match (n(request, "x"), n(request, "y")) {
        (Some(x), Some(y)) => {
            let (x, y) = (x.round() as i32, y.round() as i32);
            Ok(Some(([x, y, x, y], format!("{x},{y}"))))
        }
        (None, None) => Ok(None),
        _ => Err("Give both x and y.".into()),
    }
}

fn center(bounds: [i32; 4]) -> (i32, i32) {
    ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)
}

const QUICK: Duration = Duration::from_secs(15);

fn tap(serial: &str, request: &Value) -> Result<Outcome, String> {
    let (bounds, name) = locate(serial, request)?.ok_or("Say where to tap: `ref`, `text`, or `x` and `y`.")?;
    let (x, y) = center(bounds);
    let hold = n(request, "hold_ms").map(|ms| ms.clamp(100.0, 10_000.0) as u32);
    let mut touches = Vec::new();
    if let Some(ms) = hold {
        adb::shell(serial, &format!("input swipe {x} {y} {x} {y} {ms}"), QUICK + Duration::from_millis(ms.into()))?;
        touches.push(Touch::at(serial, "hold", x, y));
    } else {
        let times = if b(request, "double") { 2 } else { 1 };
        let command = vec![format!("input tap {x} {y}"); times].join(" && ");
        adb::shell(serial, &command, QUICK)?;
        for _ in 0..times {
            touches.push(Touch::at(serial, "tap", x, y));
        }
    }
    let verb = match (hold, b(request, "double")) {
        (Some(ms), _) => format!("Long-pressed ({ms} ms)"),
        (None, true) => "Double-tapped".into(),
        (None, false) => "Tapped".into(),
    };
    Ok(Outcome { touches, ..Outcome::text(Some(serial), format!("{verb} {name} at {x},{y}.")) })
}

fn swipe(serial: &str, request: &Value) -> Result<Outcome, String> {
    let duration = n(request, "duration_ms").map_or(300, |ms| ms.clamp(50.0, 5000.0) as u32);
    let path = if let (Some(x1), Some(y1), Some(x2), Some(y2)) =
        (n(request, "from_x"), n(request, "from_y"), n(request, "to_x"), n(request, "to_y"))
    {
        (x1.round() as i32, y1.round() as i32, x2.round() as i32, y2.round() as i32)
    } else {
        let direction = s(request, "direction").ok_or("Give a `direction` (up, down, left, right) or from_x/from_y/to_x/to_y.")?;
        let bounds = match locate(serial, request)? {
            Some((bounds, _)) if bounds[2] > bounds[0] && bounds[3] > bounds[1] => bounds,
            _ => {
                let (w, h) = adb::shell(serial, "wm size", Duration::from_secs(5))
                    .ok()
                    .and_then(|o| screen_size(&o))
                    .ok_or("Could not read the screen size.")?;
                // Sin la barra de estado ni la de gestos.
                [0, (h as f64 * 0.12) as i32, w as i32, (h as f64 * 0.88) as i32]
            }
        };
        input::scroll_path(bounds, direction, n(request, "amount").unwrap_or(0.7))
            .ok_or("`direction` must be up, down, left or right.")?
    };
    let (x1, y1, x2, y2) = path;
    adb::shell(serial, &format!("input swipe {x1} {y1} {x2} {y2} {duration}"), QUICK + Duration::from_millis(duration.into()))?;
    let touch = Touch { serial: serial.into(), kind: "swipe", x: Some(x1), y: Some(y1), x2: Some(x2), y2: Some(y2), label: None };
    let what = s(request, "direction").map_or_else(String::new, |d| format!(" (scroll {d})"));
    Ok(Outcome { touches: vec![touch], ..Outcome::text(Some(serial), format!("Swiped from {x1},{y1} to {x2},{y2}{what}.")) })
}

fn type_text(serial: &str, request: &Value) -> Result<Outcome, String> {
    let text = request.get("text").and_then(Value::as_str).unwrap_or("");
    let mut touches = Vec::new();
    let mut said = Vec::new();
    // Primero tocar el campo, si se dijo cuál.
    let field = locate(serial, &json!({ "ref": request.get("ref"), "target": request.get("target") }))?;
    if let Some((bounds, name)) = field {
        let (x, y) = center(bounds);
        adb::shell(serial, &format!("input tap {x} {y}"), QUICK)?;
        touches.push(Touch::at(serial, "tap", x, y));
        said.push(format!("tapped {name}"));
        std::thread::sleep(Duration::from_millis(250));
    }
    if b(request, "clear") {
        // Ctrl+A y borrar. `keycombination` es de Android 12; antes, ir al final y borrar.
        let cleared = adb::shell(serial, "input keycombination 113 29 && input keyevent 67", QUICK)
            .ok()
            .filter(|out| !out.contains("Error") && !out.contains("Unknown"));
        if cleared.is_none() {
            let dels = vec!["67"; 120].join(" ");
            adb::shell(serial, &format!("input keyevent 123 && input keyevent {dels}"), QUICK)?;
        }
        said.push("cleared the field".into());
    }
    let skipped = input::untypeable(text);
    let typeable: String = text.chars().filter(|c| !skipped.contains(c)).collect();
    for step in input::type_steps(&typeable) {
        match step {
            TypeStep::Text(chunk) => adb::shell(serial, &format!("input text {}", input::quote(&chunk)), QUICK)?,
            TypeStep::Key(code) => adb::shell(serial, &format!("input keyevent {code}"), QUICK)?,
        };
    }
    if !typeable.is_empty() {
        said.push(format!("typed {} characters", typeable.chars().count()));
        touches.push(Touch {
            serial: serial.into(),
            kind: "text",
            x: None,
            y: None,
            x2: None,
            y2: None,
            label: Some(typeable.chars().take(40).collect()),
        });
    }
    if b(request, "submit") {
        adb::shell(serial, "input keyevent 66", QUICK)?;
        said.push("pressed enter".into());
    }
    let mut out = if said.is_empty() { "Nothing to type.".to_string() } else { capitalize(&said.join(", ")) + "." };
    if !skipped.is_empty() {
        let list: String = skipped.iter().collect();
        out.push_str(&format!(
            " These characters can't be typed through adb and were left out: {list}. Ask the user to type them, or \
write the text without them."
        ));
    }
    Ok(Outcome { touches, ..Outcome::text(Some(serial), out) })
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn key(serial: &str, request: &Value) -> Result<Outcome, String> {
    let names: Vec<String> = match request.get("key") {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(one)) => one.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect(),
        _ => Vec::new(),
    };
    if names.is_empty() {
        return Err("Say which `key`: back, home, recents, enter, backspace, tab, escape, up/down/left/right, \
volume_up, volume_down, power, menu, search, wakeup, or a KEYCODE_ name or number."
            .into());
    }
    let mut codes = Vec::new();
    for name in &names {
        codes.push(input::keycode(name).ok_or_else(|| format!("Unknown key '{name}'."))?);
    }
    let long = if b(request, "long") { "--longpress " } else { "" };
    let list: Vec<String> = codes.iter().map(u32::to_string).collect();
    adb::shell(serial, &format!("input keyevent {long}{}", list.join(" ")), QUICK)?;
    let touch = Touch { serial: serial.into(), kind: "key", x: None, y: None, x2: None, y2: None, label: Some(names.join(" ")) };
    Ok(Outcome { touches: vec![touch], ..Outcome::text(Some(serial), format!("Pressed {}.", names.join(", "))) })
}

/// Un nombre de paquete razonable: no se le pasa al `sh` del teléfono cualquier cosa.
fn package_arg(request: &Value) -> Result<String, String> {
    let package = s(request, "package").ok_or("Say which `package` (e.g. com.example.app).")?;
    if package.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
        Ok(package.to_string())
    } else {
        Err(format!("'{package}' is not a package name."))
    }
}

fn app(serial: &str, request: &Value) -> Result<Outcome, String> {
    let action = s(request, "action").unwrap_or("current");
    let text = match action {
        "launch" | "open" | "start" => {
            let package = package_arg(request)?;
            let out = adb::shell(serial, &format!("monkey -p {package} -c android.intent.category.LAUNCHER 1"), QUICK)?;
            if out.contains("No activities found") || out.contains("monkey aborted") {
                return Err(format!("{package} is not installed or has no launcher screen. Use action=list to find it."));
            }
            format!("Launched {package}.")
        }
        "stop" | "close" => {
            let package = package_arg(request)?;
            adb::shell(serial, &format!("am force-stop {package}"), QUICK)?;
            format!("Stopped {package}.")
        }
        "open_url" | "url" | "deeplink" => {
            let url = s(request, "url").ok_or("Give the `url` (a web address or a deep link like myapp://screen).")?;
            let out = adb::shell(serial, &format!("am start -a android.intent.action.VIEW -d {}", input::quote(url)), QUICK)?;
            if out.contains("Error") {
                return Err(out.trim().to_string());
            }
            format!("Opened {url}.")
        }
        "list" => {
            let flag = if b(request, "all") { "" } else { " -3" };
            let out = adb::shell(serial, &format!("pm list packages{flag}"), QUICK)?;
            let filter = s(request, "filter").map(str::to_lowercase);
            let mut packages: Vec<&str> = out
                .lines()
                .filter_map(|l| l.trim().strip_prefix("package:"))
                .filter(|p| filter.as_deref().is_none_or(|f| p.to_lowercase().contains(f)))
                .collect();
            packages.sort_unstable();
            if packages.is_empty() {
                "No packages match.".into()
            } else {
                format!("{} packages{}:\n{}", packages.len(), if flag.is_empty() { "" } else { " (user-installed; all=true for system ones too)" }, packages.join("\n"))
            }
        }
        "current" => {
            let out = adb::shell(serial, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", QUICK).unwrap_or_default();
            let line = out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("unknown");
            format!("In the foreground: {line}")
        }
        other => return Err(format!("Unknown action '{other}': use launch, stop, open_url, list or current.")),
    };
    Ok(Outcome::text(Some(serial), text))
}

fn install(serial: &str, request: &Value, cwd: Option<&str>) -> Result<Outcome, String> {
    let action = s(request, "action").unwrap_or("install");
    let text = match action {
        "install" => {
            let raw = s(request, "path").ok_or("Give the `path` of the .apk.")?;
            let path = match cwd {
                Some(cwd) if Path::new(raw).is_relative() => Path::new(cwd).join(raw),
                _ => Path::new(raw).to_path_buf(),
            };
            if !path.is_file() {
                return Err(format!("There is no file at {}.", path.display()));
            }
            let path = path.to_string_lossy().into_owned();
            let out = adb::run(Some(serial), &["install", "-r", "-t", &path], Duration::from_secs(240))?;
            let text = String::from_utf8_lossy(&out);
            format!("Installed {path}. {}", text.lines().last().unwrap_or("").trim())
        }
        "uninstall" => {
            let package = package_arg(request)?;
            let out = adb::run(Some(serial), &["uninstall", &package], Duration::from_secs(60))?;
            format!("Uninstalled {package}: {}", String::from_utf8_lossy(&out).trim())
        }
        "clear" | "clear_data" => {
            let package = package_arg(request)?;
            let out = adb::shell(serial, &format!("pm clear {package}"), Duration::from_secs(30))?;
            format!("Cleared the data of {package}: {}", out.trim())
        }
        other => return Err(format!("Unknown action '{other}': use install, uninstall or clear.")),
    };
    Ok(Outcome::text(Some(serial), text))
}

fn wait(serial: &str, request: &Value) -> Result<Outcome, String> {
    let timeout = Duration::from_secs_f64(n(request, "timeout_s").unwrap_or(10.0).clamp(1.0, 60.0));
    let started = Instant::now();
    if let Some(text) = s(request, "text") {
        let gone = b(request, "gone");
        loop {
            let present = dump(serial).map(|nodes| ui::find_text(&nodes, text).is_some()).unwrap_or(false);
            if present != gone {
                let what = if gone { "disappeared" } else { "appeared" };
                return Ok(Outcome::text(Some(serial), format!("\"{text}\" {what} after {:.1} s.", started.elapsed().as_secs_f64())));
            }
            if started.elapsed() >= timeout {
                let what = if gone { "is still on screen" } else { "did not appear" };
                return Err(format!("\"{text}\" {what} after {} s.", timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    }
    // Sin texto: esperar a que la pantalla deje de cambiar.
    let mut last = None;
    loop {
        let frame = adb::screencap(serial)?;
        let digest = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            frame.hash(&mut h);
            h.finish()
        };
        if last == Some(digest) {
            return Ok(Outcome::text(Some(serial), format!("The screen settled after {:.1} s.", started.elapsed().as_secs_f64())));
        }
        if started.elapsed() >= timeout {
            return Err(format!("The screen kept changing for {} s.", timeout.as_secs()));
        }
        last = Some(digest);
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn logcat(serial: &str, request: &Value) -> Result<Outcome, String> {
    if b(request, "clear") {
        adb::run(Some(serial), &["logcat", "-c"], QUICK)?;
        return Ok(Outcome::text(Some(serial), "Cleared the log."));
    }
    let lines = n(request, "lines").map_or(200, |l| l.clamp(1.0, 2000.0) as u32).to_string();
    let mut args: Vec<String> = vec!["logcat".into(), "-d".into(), "-v".into(), "time".into(), "-t".into(), lines];
    if let Some(package) = s(request, "package") {
        let package = package_arg(&json!({ "package": package }))?;
        let pid = adb::shell(serial, &format!("pidof {package}"), QUICK).unwrap_or_default();
        let pid = pid.split_whitespace().next().ok_or_else(|| format!("{package} is not running. Launch it first."))?;
        args.push(format!("--pid={pid}"));
    }
    let level = s(request, "level").and_then(|l| l.chars().next()).map(|c| c.to_ascii_uppercase());
    if let Some(level) = level.filter(|c| "VDIWEF".contains(*c)) {
        args.push(format!("*:{level}"));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = adb::run(Some(serial), &refs, Duration::from_secs(20))?;
    let text = String::from_utf8_lossy(&out);
    let grep = match s(request, "grep") {
        Some(pattern) => Some(regex::Regex::new(&format!("(?i){pattern}")).map_err(|e| format!("Bad `grep`: {e}"))?),
        None => None,
    };
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !l.starts_with("---------"))
        .filter(|l| grep.as_ref().is_none_or(|re| re.is_match(l)))
        .collect();
    let body = if kept.is_empty() { "(no lines)".to_string() } else { kept.join("\n") };
    Ok(Outcome::text(Some(serial), truncate(&body, 40_000)))
}

/// Lo último de un texto largo, que es lo que importa en un log.
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…(earlier output cut)\n{}", &text[start..])
}

fn shell(serial: &str, request: &Value) -> Result<Outcome, String> {
    let command = s(request, "command").ok_or("Give the `command` to run on the device.")?;
    let timeout = Duration::from_secs_f64(n(request, "timeout_s").unwrap_or(30.0).clamp(1.0, 300.0));
    let out = adb::shell(serial, command, timeout)?;
    let body = if out.trim().is_empty() { "(no output)".to_string() } else { truncate(&out, 40_000) };
    Ok(Outcome::text(Some(serial), body))
}

fn devices_report(actor: &str) -> Result<Outcome, String> {
    let all = adb::devices()?;
    let avds = adb::avds();
    let mut out = String::new();
    if all.is_empty() {
        out.push_str("No devices are connected.");
    } else {
        let last = with_map(&LAST_USED, |m| m.get(actor).cloned());
        out.push_str("Connected:\n");
        for d in &all {
            let size = if d.ready() {
                adb::shell(&d.serial, "wm size", Duration::from_secs(5)).ok().and_then(|o| screen_size(&o))
            } else {
                None
            };
            out.push_str(&format!(
                "- {} — {}{}{}{}\n",
                d.serial,
                d.name(),
                if d.emulator { " (emulator)" } else { "" },
                if d.ready() { String::new() } else { format!(", {}: {}", d.state, state_hint(&d.state)) },
                size.map(|(w, h)| format!(", {w}x{h}")).unwrap_or_default(),
            ));
            if last.as_deref() == Some(d.serial.as_str()) {
                out.push_str("  (the one you used last)\n");
            }
        }
    }
    if !avds.is_empty() {
        out.push_str(&format!("\nEmulators you can start with android_emulator: {}.", avds.join(", ")));
    }
    Ok(Outcome::text(None, out.trim_end().to_string()))
}

fn emulator(request: &Value) -> Result<Outcome, String> {
    let Some(name) = s(request, "avd") else {
        let avds = adb::avds();
        return Ok(Outcome::text(
            None,
            if avds.is_empty() { "There are no emulators (AVDs). The user can create one in Android Studio.".into() } else { format!("Emulators: {}.", avds.join(", ")) },
        ));
    };
    let before: Vec<String> = adb::devices()?.into_iter().map(|d| d.serial).collect();
    adb::start_avd(name)?;
    // Esperar a que aparezca y termine de arrancar: recién ahí sirve para algo.
    let deadline = Instant::now() + Duration::from_secs(150);
    let mut serial = None;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));
        let now = adb::devices().unwrap_or_default();
        if serial.is_none() {
            serial = now.iter().find(|d| d.emulator && !before.contains(&d.serial)).map(|d| d.serial.clone());
        }
        if let Some(serial) = &serial {
            let booted = now.iter().any(|d| &d.serial == serial && d.ready())
                && adb::shell(serial, "getprop sys.boot_completed", Duration::from_secs(5)).is_ok_and(|o| o.trim() == "1");
            if booted {
                return Ok(Outcome::text(Some(serial), format!("{name} is running as {serial}.")));
            }
        }
    }
    Err(format!("{name} was started but did not finish booting in 150 s. Check android_devices in a moment."))
}

/// Atiende un pedido de las tools `android_*`. `actor` es quien pide (el id de su tab o
/// tarea); `cwd`, su proyecto, para las rutas relativas.
pub fn run(request: &Value, actor: &str, cwd: Option<&str>) -> Result<Outcome, String> {
    if adb::locate().is_none() {
        return Err(adb::NOT_FOUND.into());
    }
    let op = s(request, "op").ok_or("Missing 'op'.")?;
    match op {
        "devices" => return devices_report(actor),
        "emulator" => return emulator(request),
        _ => {}
    }
    let device = pick(request, actor)?;
    let serial = device.serial.as_str();
    let mut outcome = match op {
        "snapshot" => snapshot(serial, &device),
        "screenshot" => screenshot(serial, request),
        "tap" => tap(serial, request),
        "swipe" => swipe(serial, request),
        "type" => type_text(serial, request),
        "key" => key(serial, request),
        "app" => app(serial, request),
        "install" => install(serial, request, cwd),
        "wait" => wait(serial, request),
        "logcat" => logcat(serial, request),
        "shell" => shell(serial, request),
        other => Err(format!("Unknown op '{other}'.")),
    }?;
    // Si la persona está usando el dispositivo, que el agente lo sepa en vez de pelearle el
    // control: lo que vea puede haber cambiado por ella.
    if let Some(ago) = user_touched_recently(serial) {
        outcome.text.push_str(&format!(
            "\n\nNote: the user touched this device {:.0} s ago from Control Code. They may be using it; if what \
you see changed unexpectedly, that is why. Avoid fighting them for control: wait, or ask with ask_user.",
            ago.as_secs_f64().max(1.0)
        ));
    }
    Ok(outcome)
}
