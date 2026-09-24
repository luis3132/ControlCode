//! Dónde se guarda el token de cada cuenta: en el llavero del sistema.
//!
//! - macOS: el Llavero (Keychain).
//! - Windows: el Administrador de credenciales.
//! - Linux: el Secret Service (GNOME Keyring, KWallet), por D-Bus.
//!
//! Es lo mismo que hace VS Code, y por lo mismo: el token queda cifrado con la sesión del
//! usuario y no en un archivo que cualquier proceso pueda copiar.
//!
//! ## Cuando no hay llavero
//!
//! Hay Linux sin Secret Service (un WM mínimo, una sesión sin keyring desbloqueado). Ahí,
//! en vez de no poder iniciar sesión, el token va a un archivo `0600` dentro de la carpeta
//! de datos de la app — y la cuenta lo dice (`Storage::File`), para que no sea una
//! sorpresa. VS Code hace lo mismo con su almacenamiento "básico".
//!
//! Todo esto bloquea (D-Bus, Keychain), así que solo se llama desde hilos de bloqueo.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.luis.controlcode.git";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Secret {
    pub access_token: String,
    /// Solo los tokens OAuth que vencen (GitLab: 2 h) traen con qué renovarse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix, segundos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Storage {
    Keyring,
    File,
}

lazy_static::lazy_static! {
    /// Leer el llavero cuesta (y en macOS puede preguntar): una vez leído, queda acá.
    static ref CACHE: Mutex<HashMap<String, Secret>> = Mutex::new(HashMap::new());
}

fn file_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("git-secrets").join(format!("{id}.json"))
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
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

fn entry(id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, id)
}

pub fn save(data_dir: &Path, id: &str, secret: &Secret) -> Result<Storage, String> {
    let json = serde_json::to_string(secret).map_err(|e| e.to_string())?;
    let storage = match entry(id).and_then(|e| e.set_password(&json)) {
        Ok(()) => {
            // Si antes estaba en archivo (no había llavero y ahora sí), que no quede ahí.
            let _ = std::fs::remove_file(file_path(data_dir, id));
            Storage::Keyring
        }
        Err(e) => {
            eprintln!("[forge] llavero no disponible ({e}); el token va a un archivo 0600");
            write_file(&file_path(data_dir, id), &json)?;
            Storage::File
        }
    };
    CACHE.lock().unwrap().insert(id.to_string(), secret.clone());
    Ok(storage)
}

pub fn load(data_dir: &Path, id: &str) -> Result<Secret, String> {
    if let Some(s) = CACHE.lock().unwrap().get(id) {
        return Ok(s.clone());
    }
    let json = match entry(id).and_then(|e| e.get_password()) {
        Ok(json) => json,
        Err(keyring_err) => std::fs::read_to_string(file_path(data_dir, id)).map_err(|_| {
            format!("No se encontró el token de esta cuenta ({keyring_err}). Volvé a iniciar sesión.")
        })?,
    };
    let secret: Secret = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    CACHE.lock().unwrap().insert(id.to_string(), secret.clone());
    Ok(secret)
}

/// Dónde está guardado, sin leerlo. Para mostrarlo en la cuenta.
pub fn storage_of(data_dir: &Path, id: &str) -> Storage {
    if file_path(data_dir, id).exists() {
        Storage::File
    } else {
        Storage::Keyring
    }
}

pub fn delete(data_dir: &Path, id: &str) {
    CACHE.lock().unwrap().remove(id);
    if let Ok(e) = entry(id) {
        let _ = e.delete_credential();
    }
    let _ = std::fs::remove_file(file_path(data_dir, id));
}

#[cfg(test)]
pub fn clear_cache_for_tests() {
    CACHE.lock().unwrap().clear();
}
