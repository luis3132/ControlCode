//! Helpers de disco: resolver el SKILL.md elegido, leerlo y copiar su carpeta.

use std::path::{Path, PathBuf};

use super::frontmatter::parse_frontmatter;
use super::types::SkillFrontmatter;

/// Valida que `source_file` sea un `SKILL.md` real y devuelve `(archivo, carpeta que lo
/// contiene)` — la carpeta es la que se termina copiando entera al instalar, porque una
/// skill suele traer archivos de soporte junto al SKILL.md (scripts, assets, etc.), pero
/// el usuario elige explícitamente el archivo, no la carpeta.
pub(super) fn resolve_skill_file(source_file: &str) -> Result<(PathBuf, PathBuf), String> {
    let file = PathBuf::from(source_file);
    let is_skill_md = file
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("SKILL.md"))
        .unwrap_or(false);
    if !is_skill_md {
        return Err("Selecciona un archivo SKILL.md".to_string());
    }
    if !file.is_file() {
        return Err(format!("No se encontró el archivo {source_file}"));
    }
    let folder = file
        .parent()
        .ok_or_else(|| "No se pudo determinar la carpeta del archivo".to_string())?
        .to_path_buf();
    Ok((file, folder))
}

/// Lee un SKILL.md y devuelve su frontmatter parseado + contenido crudo, o `None` si
/// el archivo no se puede leer.
pub(super) fn scan_skill_file(file: &Path) -> Option<(SkillFrontmatter, String)> {
    let content = std::fs::read_to_string(file).ok()?;
    let meta = parse_frontmatter(&content);
    Some((meta, content))
}

pub(super) fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        // Los separadores consecutivos colapsan en uno solo: sin esto, un nombre de repo
        // como `autoskills (midudev)` daba `autoskills--midudev`, con el doble guión a la
        // vista en la ruta de la carpeta.
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "skill".to_string() } else { slug }
}

pub(super) fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest_path)?;
        }
        // symlinks dentro de la carpeta fuente se ignoran deliberadamente: no tiene
        // sentido copiar un symlink a la copia global, podría apuntar fuera de ella.
    }
    Ok(())
}

pub(super) fn slug_from_source_path(source_path: &str) -> String {
    Path::new(source_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}
