//! Las fotos del navegador de las tabs para anotar encima: sacarlas (ver `snapshot`) y
//! guardarlas donde un agente las pueda abrir.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Runtime, Webview};

use super::snapshot;

/// Cuánto se espera al motor. Una captura tarda decenas de milisegundos; si no llegó en
/// esto, no va a llegar.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Una captura anotada pesa unos cientos de KB; esto es solo para no escribir cualquier cosa.
const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;

/// Lo que se guardó hace más de esto se borra al guardar otra: el agente la lee en el
/// momento, y la carpeta temporal no tiene por qué ir llenándose.
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// La foto del webview de la app entero, como PNG. El frontend recorta la página.
#[tauri::command]
pub async fn preview_capture<R: Runtime>(webview: Webview<R>) -> Result<Response, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let done: snapshot::Done = Box::new(move |result| {
        let _ = tx.send(result);
    });
    webview
        .with_webview(move |platform| {
            #[cfg(target_os = "linux")]
            snapshot::capture(&platform.inner(), done);
            #[cfg(windows)]
            snapshot::capture(&platform.controller(), done);
            #[cfg(target_os = "macos")]
            snapshot::capture(platform.inner(), done);
            #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
            {
                let _ = platform;
                done(Err("este sistema no permite capturar el navegador".into()));
            }
        })
        .map_err(|e| e.to_string())?;
    let png = tokio::time::timeout(CAPTURE_TIMEOUT, rx)
        .await
        .map_err(|_| "la captura tardó demasiado".to_string())?
        .map_err(|_| "la captura se canceló".to_string())??;
    Ok(Response::new(png))
}

/// Guarda una captura (el PNG va crudo en el cuerpo del pedido) y devuelve su ruta.
///
/// En la carpeta temporal del sistema y no en el proyecto: dentro del workspace aparecería
/// en git, y cualquier agente de la máquina puede leer la temporal.
#[tauri::command]
pub fn preview_save_capture(request: Request<'_>) -> Result<String, String> {
    let path = match request.body() {
        InvokeBody::Raw(png) => save_capture(&capture_dir(), png, SystemTime::now())?,
        // Si el webview no deja usar el protocolo del IPC, Tauri cae a `postMessage` y los
        // bytes llegan como una lista de números.
        InvokeBody::Json(value) => {
            let png: Vec<u8> = serde_json::from_value(value.clone()).map_err(|_| "la captura tiene que llegar como bytes".to_string())?;
            save_capture(&capture_dir(), &png, SystemTime::now())?
        }
    };
    Ok(path.to_string_lossy().into_owned())
}

fn capture_dir() -> PathBuf {
    std::env::temp_dir().join("controlcode").join("capturas")
}

fn save_capture(dir: &Path, png: &[u8], now: SystemTime) -> Result<PathBuf, String> {
    if !png.starts_with(PNG_SIGNATURE) {
        return Err("la captura no es un PNG".into());
    }
    if png.len() > MAX_CAPTURE_BYTES {
        return Err("la captura es demasiado grande".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
    prune(dir, now);
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("captura-{secs}-{}.png", &id[..8]));
    fs::write(&path, png).map_err(|e| format!("no se pudo guardar la captura: {e}"))?;
    Ok(path)
}

/// Borra las capturas viejas. Solo las nuestras (`captura-*.png`): la carpeta es propia,
/// pero no cuesta nada no confiar en eso.
fn prune(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("captura-") || !name.ends_with(".png") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-capturas-test-{name}-{}", uuid::Uuid::new_v4().simple()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn guarda_un_png_y_devuelve_donde() {
        let dir = dir("guarda");
        let png = [PNG_SIGNATURE, b"resto"].concat();
        let path = save_capture(&dir, &png, SystemTime::now()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), png);
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("captura-"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_guarda_lo_que_no_es_un_png() {
        let dir = dir("rechaza");
        assert!(save_capture(&dir, b"<html>", SystemTime::now()).is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn al_guardar_borra_las_capturas_de_ayer_y_nada_mas() {
        let dir = dir("limpia");
        fs::create_dir_all(&dir).unwrap();
        let vieja = dir.join("captura-1-aaaa.png");
        let ajeno = dir.join("notas.txt");
        fs::write(&vieja, PNG_SIGNATURE).unwrap();
        fs::write(&ajeno, "no es mío").unwrap();
        // "Ahora" es dentro de dos días: las dos quedan viejas, pero solo se borra la captura.
        let later = SystemTime::now() + Duration::from_secs(2 * 24 * 60 * 60);
        let nueva = save_capture(&dir, PNG_SIGNATURE, later).unwrap();
        assert!(!vieja.exists());
        assert!(ajeno.exists());
        assert!(nueva.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}

// ── Archivos que un agente le da a la página ─────────────────────

/// Lo que pesa como mucho un archivo que se sube a un formulario desde el MCP. Más que
/// esto no es un adjunto de prueba: es algo que hay que mirar de otra forma.
const MAX_UPLOAD_BYTES: u64 = 10 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub name: String,
    pub mime: String,
    /// Los bytes en base64: es lo único que cruza un `postMessage` igual en los tres motores.
    pub data: String,
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" | "md" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Un archivo del disco, listo para que la página lo ponga en un `<input type=file>`.
#[tauri::command]
pub fn preview_read_upload(path: String) -> Result<UploadFile, String> {
    use base64::Engine;
    let file = Path::new(&path);
    let meta = fs::metadata(file).map_err(|e| format!("no se pudo leer {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} es una carpeta"));
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "{path} pesa {} MB; el máximo para subir a un formulario es {} MB",
            meta.len() / (1024 * 1024),
            MAX_UPLOAD_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(file).map_err(|e| format!("no se pudo leer {path}: {e}"))?;
    Ok(UploadFile {
        name: file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "archivo".into()),
        mime: mime_for(file).to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
