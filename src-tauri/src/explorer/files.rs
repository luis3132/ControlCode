//! Leer y guardar un archivo del workspace, para las tabs de archivo.
//!
//! La tab no guarda el archivo en memoria como fuente de verdad: el disco lo es, porque
//! los agentes escriben ahí todo el tiempo. Por eso cada lectura devuelve la fecha de
//! modificación, y guardar exige presentarla — si otro la cambió en el medio, no se pisa.

use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;

/// Más que esto no se abre como texto: un editor con un log de 50 MB adentro deja de
/// responder, y para leer eso está la terminal.
const MAX_TEXT: u64 = 5 * 1024 * 1024;

/// Las imágenes viajan enteras en base64; más de esto ya no es una imagen de proyecto.
const MAX_IMAGE: u64 = 20 * 1024 * 1024;

/// Cuánto se mira del principio para decidir si es binario. Es lo mismo que hace git.
const SNIFF: usize = 8000;

const IMAGES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
];

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileContent {
    Text { content: String, mtime: i64, size: u64 },
    /// `data:` listo para un `<img>`.
    Image { data_url: String, mtime: i64, size: u64 },
    /// No es texto (o no es UTF-8). Se dice en vez de mostrar basura: y editar basura y
    /// guardarla corrompería el archivo.
    Binary { size: u64 },
    TooLarge { size: u64 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteOutcome {
    Saved { mtime: i64 },
    /// Cambió en disco desde que se leyó. No se escribió nada.
    Conflict { mtime: i64 },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime: i64,
    pub size: u64,
}

/// Milisegundos desde epoch. En `i64` y no `u128` porque viaja a JS como número.
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn looks_binary(head: &[u8]) -> bool {
    head.iter().take(SNIFF).any(|b| *b == 0)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGES.iter().find(|(e, _)| *e == ext).map(|(_, mime)| *mime)
}

#[tauri::command]
pub fn explorer_read_file(path: String) -> Result<FileContent, String> {
    let file = Path::new(&path);
    let meta = std::fs::metadata(file).map_err(|e| format!("no se pudo leer {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} es una carpeta"));
    }
    let size = meta.len();
    let mtime = mtime_ms(&meta);

    if let Some(mime) = image_mime(file) {
        if size > MAX_IMAGE {
            return Ok(FileContent::TooLarge { size });
        }
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(FileContent::Image { data_url: format!("data:{mime};base64,{data}"), mtime, size });
    }

    if size > MAX_TEXT {
        return Ok(FileContent::TooLarge { size });
    }

    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(file)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("no se pudo leer {path}: {e}"))?;

    if looks_binary(&bytes) {
        return Ok(FileContent::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent::Text { content, mtime, size }),
        Err(_) => Ok(FileContent::Binary { size }),
    }
}

/// `None` = ya no existe (lo borró un agente con la tab abierta).
#[tauri::command]
pub fn explorer_file_stat(path: String) -> Result<Option<FileStat>, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(Some(FileStat { mtime: mtime_ms(&meta), size: meta.len() })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Guarda solo si el archivo sigue como estaba cuando se leyó (`expected_mtime`).
///
/// Sin esa condición, guardar una tab abierta hace un rato pisaría en silencio lo que un
/// agente escribió mientras tanto — y es exactamente lo que pasa en esta app todo el día.
#[tauri::command]
pub fn explorer_write_file(
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<WriteOutcome, String> {
    // Se escribe sobre el archivo REAL: si la ruta es un symlink (las skills adjuntas lo
    // son), un rename sobre el enlace lo reemplazaría por un archivo suelto y la skill
    // dejaría de recibir cambios.
    let target = std::fs::canonicalize(&path).unwrap_or_else(|_| Path::new(&path).to_path_buf());

    if let (Some(expected), Ok(meta)) = (expected_mtime, std::fs::metadata(&target)) {
        let current = mtime_ms(&meta);
        if current != expected {
            return Ok(WriteOutcome::Conflict { mtime: current });
        }
    }

    write_atomic(&target, content.as_bytes())?;
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    Ok(WriteOutcome::Saved { mtime: mtime_ms(&meta) })
}

/// Temporal al lado y `rename`: un corte a mitad de camino deja el original intacto. El
/// temporal hereda los permisos del original, o un script ejecutable dejaría de serlo.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.controlcode-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("no se pudo escribir {}: {e}", tmp.display()))?;

    if let Ok(meta) = std::fs::metadata(path) {
        if let Err(e) = std::fs::set_permissions(&tmp, meta.permissions()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("no se pudieron copiar los permisos: {e}"));
        }
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("no se pudo guardar {}: {e}", path.display())
    })
}
