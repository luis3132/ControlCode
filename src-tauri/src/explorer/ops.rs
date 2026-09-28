//! Lo que se le hace a un archivo desde el menú del árbol: crear, renombrar, copiar, mover
//! y mandar a la papelera.
//!
//! Ninguna operación pisa nada. Crear o renombrar sobre algo que ya existe falla; copiar
//! o pegar sobre un nombre ocupado elige otro (`a copy.ts`, `a copy 2.ts`), como VS Code.
//! Borrar va a la papelera del sistema y no se pierde: es un click derecho, y un click
//! derecho mal apuntado no puede costar un archivo.

use std::fs;
use std::path::{Path, PathBuf};

fn exists(p: &Path) -> bool {
    // `exists()` sigue symlinks: uno roto daría `false` y se escribiría encima.
    p.symlink_metadata().is_ok()
}

/// Un nombre, no una ruta. Sin esto, "../../x" como nombre nuevo escaparía de la carpeta.
fn check_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("nombre inválido".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("\"{name}\" no puede llevar separadores de ruta"));
    }
    #[cfg(windows)]
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with('.') || name.ends_with(' ') {
        return Err(format!("\"{name}\" no es un nombre válido en Windows"));
    }
    Ok(())
}

fn child(dir: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let dir = Path::new(dir);
    if !dir.is_dir() {
        return Err(format!("{} no es un directorio", dir.display()));
    }
    Ok(dir.join(name.trim()))
}

fn out(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

#[tauri::command]
pub fn explorer_create_file(dir: String, name: String) -> Result<String, String> {
    let path = child(&dir, &name)?;
    // `create_new` falla si ya existe, en el mismo syscall: no hay carrera entre mirar y
    // crear en la que un agente pueda escribir el archivo y perderlo.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
    Ok(out(&path))
}

#[tauri::command]
pub fn explorer_create_dir(dir: String, name: String) -> Result<String, String> {
    let path = child(&dir, &name)?;
    fs::create_dir(&path).map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;
    Ok(out(&path))
}

#[tauri::command]
pub fn explorer_rename(path: String, name: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let parent = from.parent().ok_or("no se puede renombrar la raíz")?;
    let to = child(&parent.to_string_lossy(), &name)?;
    if to == from {
        return Ok(path);
    }
    // Cambiar solo mayúsculas (`readme.md` → `README.md`) en un disco que no las distingue
    // (Windows, macOS) hace que `to` "exista": es el mismo archivo, y se deja pasar.
    let same_file = to.to_string_lossy().to_lowercase() == from.to_string_lossy().to_lowercase();
    if exists(&to) && !same_file {
        return Err(format!("ya existe {}", to.display()));
    }
    fs::rename(&from, &to).map_err(|e| format!("no se pudo renombrar: {e}"))?;
    Ok(out(&to))
}

/// `a.ts` → `a copy.ts` → `a copy 2.ts`… El primero libre en `dir`. Las carpetas y los
/// archivos sin extensión llevan el sufijo al final; los ocultos (`.env`) también, porque
/// su "extensión" es el nombre entero.
pub(crate) fn free_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") };
        let p = dir.join(candidate);
        if !exists(&p) {
            return p;
        }
        n += 1;
    }
}

/// Copia recursiva. Los symlinks se copian como symlinks: seguirlos metería adentro una
/// carpeta de skills entera (o se colgaría con uno que apunta a un ancestro).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = from.symlink_metadata()?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, to);
        #[cfg(windows)]
        return if from.is_dir() {
            std::os::windows::fs::symlink_dir(target, to)
        } else {
            std::os::windows::fs::symlink_file(target, to)
        };
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(from, to).map(|_| ())
}

/// `inner` es `outer` o está adentro. Se compara canonicalizado: con symlinks o `..` de
/// por medio, comparar strings no alcanza.
fn is_within(inner: &Path, outer: &Path) -> bool {
    match (inner.canonicalize(), outer.canonicalize()) {
        (Ok(i), Ok(o)) => i.starts_with(o),
        _ => false,
    }
}

fn source(path: &str) -> Result<(PathBuf, String), String> {
    let from = PathBuf::from(path);
    if !exists(&from) {
        return Err(format!("{path} ya no existe"));
    }
    let name = from
        .file_name()
        .ok_or("no se puede copiar la raíz")?
        .to_string_lossy()
        .to_string();
    Ok((from, name))
}

fn target_dir(dir: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(format!("{} no es un directorio", dir.display()));
    }
    Ok(dir)
}

/// Copia `path` adentro de `dir`. Pegar en la misma carpeta es duplicar: el nombre libre
/// que le toca es `x copy`.
#[tauri::command]
pub fn explorer_copy(path: String, dir: String) -> Result<String, String> {
    let (from, name) = source(&path)?;
    let dir = target_dir(&dir)?;
    if from.is_dir() && is_within(&dir, &from) {
        return Err("no se puede copiar una carpeta adentro de sí misma".into());
    }
    let to = free_name(&dir, &name, from.is_dir());
    copy_tree(&from, &to).map_err(|e| {
        // Una copia a medias de una carpeta confunde más que ninguna.
        let _ = if to.is_dir() { fs::remove_dir_all(&to) } else { fs::remove_file(&to) };
        format!("no se pudo copiar {}: {e}", from.display())
    })?;
    Ok(out(&to))
}

/// Mueve `path` adentro de `dir`, con el mismo nombre. Si ya hay algo con ese nombre
/// falla: mover es arrastrar, y un arrastre no debería reemplazar nada sin preguntar.
#[tauri::command]
pub fn explorer_move(path: String, dir: String) -> Result<String, String> {
    let (from, name) = source(&path)?;
    let dir = target_dir(&dir)?;
    if from.parent() == Some(dir.as_path()) {
        return Ok(path);
    }
    if from.is_dir() && is_within(&dir, &from) {
        return Err("no se puede mover una carpeta adentro de sí misma".into());
    }
    let to = dir.join(&name);
    if exists(&to) {
        return Err(format!("ya existe {name} en {}", dir.display()));
    }
    if fs::rename(&from, &to).is_err() {
        // `rename` no cruza discos (EXDEV en Unix, otra letra de unidad en Windows): ahí
        // se copia y después se borra el original, solo si la copia salió entera.
        copy_tree(&from, &to).map_err(|e| format!("no se pudo mover {}: {e}", from.display()))?;
        let removed = if from.is_dir() && !from.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            fs::remove_dir_all(&from)
        } else {
            fs::remove_file(&from)
        };
        removed.map_err(|e| format!("se copió, pero no se pudo borrar el original: {e}"))?;
    }
    Ok(out(&to))
}

/// A la papelera del sistema (Papelera de reciclaje en Windows, Papelera en macOS, la de
/// freedesktop en Linux), no un borrado definitivo.
#[tauri::command]
pub fn explorer_trash(paths: Vec<String>) -> Result<(), String> {
    let existing: Vec<&String> = paths.iter().filter(|p| exists(Path::new(p))).collect();
    if existing.is_empty() {
        return Ok(());
    }
    trash::delete_all(existing).map_err(|e| format!("no se pudo mandar a la papelera: {e}"))
}
