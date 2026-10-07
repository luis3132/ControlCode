//! Helpers de disco: resolver la skill elegida (una carpeta, un SKILL.md o un `.md` suelto),
//! leerla y copiar su carpeta.

use std::path::{Path, PathBuf};

use super::frontmatter::parse_frontmatter;
use super::types::SkillFrontmatter;

/// Una skill lista para instalar, venga como venga.
pub(crate) struct ResolvedSkill {
    /// El markdown de la skill.
    pub md: PathBuf,
    /// La carpeta que se copia entera al store (con los archivos de soporte que traiga).
    pub folder: PathBuf,
    /// El nombre si el frontmatter no trae uno: el de la carpeta, o el del archivo suelto.
    pub default_name: String,
    /// Un markdown que no se llama `SKILL.md` y que, una vez escrito el `SKILL.md` en la
    /// copia, sobra: se borra de ahí para que la skill no quede duplicada.
    pub replaced_md: Option<std::ffi::OsString>,
    /// La carpeta temporal donde se armó un `.md` suelto. Se borra al soltarla.
    _stage: Option<StageDir>,
}

/// Una carpeta temporal que se borra sola.
struct StageDir(PathBuf);
impl Drop for StageDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn is_md(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn is_skill_md(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "skill".to_string())
}

/// El markdown de una carpeta-skill: su `SKILL.md`; si no tiene, el que se llama como la
/// carpeta (`facturas-crear/facturas-crear.md`); si no, el único `.md` que haya. Con
/// varios y ninguno de esos, no se adivina.
pub(crate) fn find_skill_md_in_dir(dir: &Path) -> Option<PathBuf> {
    let mds: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_md(p))
        .collect();
    if let Some(skill) = mds.iter().find(|p| is_skill_md(p)) {
        return Some(skill.clone());
    }
    let folder = dir.file_name().map(|n| n.to_string_lossy().to_lowercase());
    if let Some(named) = mds.iter().find(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()) == folder) {
        return Some(named.clone());
    }
    match mds.as_slice() {
        [only] => Some(only.clone()),
        _ => None,
    }
}

/// El markdown de una entrada de skill: el de la carpeta (ver [`find_skill_md_in_dir`]) o
/// el archivo mismo si es un `.md` suelto. `None` = ahí no hay una skill.
pub(crate) fn skill_markdown(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        find_skill_md_in_dir(path)
    } else if path.is_file() && is_md(path) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

/// Resuelve lo que eligió la persona (o lo que trae un repositorio local) a una skill.
///
/// - **Una carpeta**: es la skill, con su nombre. Adentro, el markdown que diga
///   [`find_skill_md_in_dir`]; no hace falta que se llame `SKILL.md`.
/// - **Un `SKILL.md`**: su carpeta es la skill, como siempre.
/// - **Cualquier otro `.md`** (`facturas-crear.md`): es la skill entera. Se arma una
///   carpeta `facturas-crear/` con él adentro como `SKILL.md`. NO se copia la carpeta que
///   lo contiene: un `.md` suelto en Descargas metería Descargas entera en la skill.
pub(crate) fn resolve_skill_source(source: &str) -> Result<ResolvedSkill, String> {
    let path = PathBuf::from(source);
    if path.is_dir() {
        let md = find_skill_md_in_dir(&path).ok_or_else(|| {
            format!("{source} no tiene un archivo .md de skill (SKILL.md, o uno solo .md, o uno que se llame como la carpeta)")
        })?;
        let replaced_md = (!is_skill_md(&md)).then(|| md.file_name().map(|n| n.to_os_string())).flatten();
        return Ok(ResolvedSkill { default_name: name_of(&path), folder: path, md, replaced_md, _stage: None });
    }
    if !path.is_file() {
        return Err(format!("No se encontró {source}"));
    }
    if !is_md(&path) {
        return Err("Elegí un archivo .md o la carpeta de la skill".to_string());
    }
    if is_skill_md(&path) {
        let folder = path
            .parent()
            .ok_or_else(|| "No se pudo determinar la carpeta del archivo".to_string())?
            .to_path_buf();
        return Ok(ResolvedSkill { default_name: name_of(&folder), folder, md: path, replaced_md: None, _stage: None });
    }

    // Un `.md` suelto: se arma su carpeta en un temporal y desde ahí se instala igual que
    // cualquier otra.
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "skill".to_string());
    let content = std::fs::read_to_string(&path).map_err(|e| format!("No se pudo leer {source}: {e}"))?;
    let root = std::env::temp_dir().join(format!("cc-skill-{}", uuid::Uuid::new_v4()));
    let stage = StageDir(root.clone());
    let folder = root.join(slugify(&stem));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let md = folder.join("SKILL.md");
    std::fs::write(&md, content).map_err(|e| e.to_string())?;
    Ok(ResolvedSkill { md, folder, default_name: stem, replaced_md: None, _stage: Some(stage) })
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
