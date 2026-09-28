//! Dónde está el relay, cómo se llama este equipo y su par de claves.

use controlcode_relay::crypto::{Keypair, b64, unb64};
use serde::{Deserialize, Serialize};

use crate::database::{DbConnection, get_setting, set_setting};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub enabled: bool,
    /// `wss://relay.ejemplo.com`, como lo escribió la persona.
    pub relay_url: String,
    /// El de `CC_RELAY_TOKEN`, si el relay pide uno.
    pub token: Option<String>,
    /// Cómo aparece este equipo en el teléfono.
    pub name: String,
}

const ENABLED: &str = "remote.enabled";
const RELAY: &str = "remote.relayUrl";
const TOKEN: &str = "remote.token";
const NAME: &str = "remote.name";

fn default_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|h| !h.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|h| h.trim().to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "Control Code".into())
}

pub fn load(db: &DbConnection) -> RemoteConfig {
    let get = |k: &str| get_setting(db, k).ok().flatten().filter(|v| !v.trim().is_empty());
    RemoteConfig {
        enabled: get(ENABLED).as_deref() == Some("1"),
        relay_url: get(RELAY).unwrap_or_default(),
        token: get(TOKEN),
        name: get(NAME).unwrap_or_else(default_name),
    }
}

pub fn save(db: &DbConnection, config: &RemoteConfig) -> Result<(), String> {
    if config.enabled {
        ws_url(&config.relay_url)?;
    }
    set_setting(db, ENABLED, if config.enabled { "1" } else { "0" })?;
    set_setting(db, RELAY, config.relay_url.trim())?;
    set_setting(db, TOKEN, config.token.as_deref().unwrap_or("").trim())?;
    set_setting(db, NAME, config.name.trim())?;
    Ok(())
}

/// La dirección del WebSocket del relay a partir de lo que escribió la persona.
///
/// Acepta `relay.ejemplo.com`, `https://…` o `wss://…`, con o sin la ruta: lo que se
/// escribe en un campo de texto rara vez es exactamente la URL del socket.
pub fn ws_url(input: &str) -> Result<String, String> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err("Falta la dirección del relay".into());
    }
    let (scheme, rest) = match input.split_once("://") {
        Some(("wss" | "https", rest)) => ("wss", rest),
        Some(("ws" | "http", rest)) => ("ws", rest),
        Some((other, _)) => return Err(format!("'{other}://' no es una dirección de relay (usá wss://)")),
        None => ("wss", input),
    };
    if rest.is_empty() || rest.starts_with('/') || rest.chars().any(char::is_whitespace) {
        return Err("Dirección de relay inválida".into());
    }
    let with_path = if rest.contains('/') { rest.to_string() } else { format!("{rest}/v1/ws") };
    Ok(format!("{scheme}://{with_path}"))
}

/// La dirección base (sin la ruta del socket), que es lo que va en el QR.
pub fn base_url(input: &str) -> Result<String, String> {
    let url = ws_url(input)?;
    Ok(url.strip_suffix("/v1/ws").unwrap_or(&url).to_string())
}

// ── Claves ───────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "controlcode-remote";
const KEYRING_ACCOUNT: &str = "desktop-key";

fn key_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("remote").join("desktop.key")
}

fn write_private(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content).map_err(|e| e.to_string())
    }
}

/// El par de claves de este equipo: se crea la primera vez y queda en el llavero del
/// sistema (o, sin llavero, en un archivo `0600`, igual que los tokens de git).
///
/// Es la identidad ante los teléfonos: si se perdiera, habría que volver a emparejarlos.
/// Bloquea (D-Bus, Keychain): llamarlo desde un hilo de bloqueo.
pub fn load_or_create_keys(data_dir: &std::path::Path) -> Result<Keypair, String> {
    let parse = |text: &str| -> Option<Keypair> {
        let bytes: [u8; 32] = unb64(text.trim()).ok()?.try_into().ok()?;
        Some(Keypair::from_secret(bytes))
    };
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok();
    if let Some(keys) = entry.as_ref().and_then(|e| e.get_password().ok()).and_then(|s| parse(&s)) {
        return Ok(keys);
    }
    if let Some(keys) = std::fs::read_to_string(key_file(data_dir)).ok().and_then(|s| parse(&s)) {
        return Ok(keys);
    }
    let keys = Keypair::generate();
    let secret = b64(&keys.secret);
    match entry.map(|e| e.set_password(&secret)) {
        Some(Ok(())) => {}
        _ => {
            eprintln!("[remote] llavero no disponible; la clave del equipo va a un archivo 0600");
            write_private(&key_file(data_dir), &secret)?;
        }
    }
    Ok(keys)
}
