//! Crear skills propias y editar las que vinieron de un repositorio.
//!
//! ## Por qué editar una skill de repo hace una COPIA
//!
//! La copia global de una skill instalada desde un repositorio es un reflejo de lo que ese
//! repositorio publica: refrescar el repo y reinstalarla la reemplaza entera (ver
//! `install::update_installed`). Guardar los cambios ahí sería escribir en un archivo que
//! la app se reserva el derecho de pisar — el usuario perdería su trabajo en la primera
//! actualización, sin ningún aviso.
//!
//! Por eso editar una de repositorio produce una skill NUEVA, de origen local: es suya, no
//! la toca nadie, y la del repo sigue ahí para seguir recibiendo actualizaciones.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;

use super::install::install_skill_internal;
use super::store::{skill_content, update_skill_content_inner};
use super::types::{SkillFrontmatterInput, SkillInfo};

/// Lo que manda el constructor de skills: la metadata más el cuerpo del SKILL.md.
///
/// El cuerpo va aparte del frontmatter a propósito: en el constructor el usuario escribe
/// las instrucciones y llena los campos en un formulario, sin tener que saber que arriba
/// del archivo hay un bloque YAML con una sintaxis que puede romper.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub meta: SkillFrontmatterInput,
    /// El markdown de abajo del frontmatter: las instrucciones para el agente.
    pub body: String,
}

/// Sufijo del nombre de una copia cuando el usuario no eligió uno.
///
/// Neutro en cualquier idioma y válido como nombre de carpeta — los nombres de skill son
/// slugs (`git-helper`), así que `git-helper-local` se lee natural y además dice de dónde
/// salió. Que se repita con otra copia no es problema: la identidad de una skill es su
/// origen, no su nombre (ver `SkillOrigin`).
const COPY_SUFFIX: &str = "-local";

/// Crea una skill propia, de origen local, desde el constructor.
#[tauri::command]
pub fn create_skill(draft: SkillDraft, db: tauri::State<DbConnection>) -> Result<SkillInfo, String> {
    let name = draft
        .meta
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "La skill necesita un nombre".to_string())?
        .to_string();

    // Se materializa en una carpeta temporal y de ahí entra por el MISMO camino que
    // cualquier otra instalación: así hereda la resolución de slug sin colisiones, la
    // carpeta `local`, el registro en la base y la normalización del frontmatter, en vez
    // de tener un segundo camino de alta que se desincronice del primero.
    let staging = std::env::temp_dir().join(format!("controlcode-new-skill-{}", uuid::Uuid::new_v4()));
    let folder = staging.join(super::files::slugify(&name));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;

    let mut meta = draft.meta.clone();
    meta.name = Some(name);
    let content = super::frontmatter::render_skill_md(&meta.clone().into(), &draft.body);
    std::fs::write(folder.join("SKILL.md"), content).map_err(|e| e.to_string())?;

    let result = install_skill_internal(
        &folder.join("SKILL.md").to_string_lossy(),
        Some(meta),
        // Sin origen: es del usuario, no de ningún repositorio.
        None,
        &db,
    );

    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Guarda una skill como una copia NUEVA de origen local.
///
/// Se copia la carpeta entera y no solo el SKILL.md: una skill puede traer scripts y
/// assets al lado, y una copia sin ellos sería una skill rota que además parece completa.
///
/// `name` vacío = el nombre de la original con [`COPY_SUFFIX`]. `content` vacío = el
/// contenido actual (copiar sin editar es un caso válido: partir de una skill de un repo
/// para después modificarla).
#[tauri::command]
pub fn fork_skill(
    skill_id: String,
    name: Option<String>,
    content: Option<String>,
    db: tauri::State<DbConnection>,
) -> Result<SkillInfo, String> {
    let (source_path, original_name) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT source_path, name FROM skills WHERE id = ?1",
            [&skill_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|_| "Esa skill ya no existe".to_string())?
    };

    let copy = install_skill_internal(
        &Path::new(&source_path).join("SKILL.md").to_string_lossy(),
        None,
        None,
        &db,
    )?;

    // El contenido y el nombre se aplican DESPUÉS de copiar: `install_skill_internal`
    // parte del archivo original, y lo que el usuario acaba de escribir todavía no está en
    // disco en ningún lado.
    let new_name = name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{original_name}{COPY_SUFFIX}"));

    let body_source = match content {
        Some(c) => c,
        None => skill_content(&copy.source_path)?,
    };
    let final_content = super::frontmatter::rename_in_content(&body_source, &new_name);

    let conn = db.lock().map_err(|e| e.to_string())?;
    update_skill_content_inner(&conn, &copy.id, &final_content)?;
    super::links::fetch_skill_row(&conn, &copy.id)
}
