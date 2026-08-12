//! Instalar y desinstalar skills: la copia global bajo el directorio configurado.

use std::path::Path;
use uuid::Uuid;

use crate::database::DbConnection;

use super::files::{copy_dir_recursive, resolve_skill_file, scan_skill_file, slugify};
use super::frontmatter::split_frontmatter;
use super::frontmatter::render_skill_md;
use super::links::reconcile_link_dirs;
use super::settings::resolve_skills_dir;
use super::store::collect_linked_tabs;
use super::types::{
    missing_fields, now_ts, SkillFrontmatter, SkillFrontmatterInput, SkillInfo, SkillPreview,
};

/// Lee el SKILL.md elegido y devuelve su metadata parseada más la lista de campos
/// "sugeridos" que no vinieron en el frontmatter — el frontend usa `missing` para
/// decidir si mostrar un formulario de metadata antes de instalar.
#[tauri::command]
pub fn preview_skill_metadata(source_file: String) -> Result<SkillPreview, String> {
    let (file, folder) = resolve_skill_file(&source_file)?;
    let Some((meta, _content)) = scan_skill_file(&file) else {
        return Err(format!("No se pudo leer {source_file}"));
    };
    let folder_name = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let missing = missing_fields(&meta);
    Ok(SkillPreview { meta: meta.into(), folder_name, missing })
}

#[tauri::command]
pub fn install_skill(
    source_file: String,
    overrides: Option<SkillFrontmatterInput>,
    db: tauri::State<DbConnection>,
) -> Result<SkillInfo, String> {
    install_skill_internal(&source_file, overrides, None, &db)
}

/// Repo del que viene una skill que se está instalando: su id y su nombre visible.
/// `None` en una instalación manual desde un archivo del disco.
pub(crate) type SkillOrigin<'a> = Option<(&'a str, &'a str)>;

/// Carpeta donde vive la copia global de una skill, dentro del directorio de skills.
///
/// Una por repositorio, más `local` para las instaladas a mano. Dos repos pueden traer
/// skills con el mismo nombre y funcionalidad distinta (`testing` de uno no es `testing`
/// del otro), así que mezclarlas en un solo nivel las hacía competir por la misma carpeta.
pub(super) fn bucket_for_origin(origin: SkillOrigin) -> String {
    match origin {
        Some((_, registry_name)) => slugify(registry_name),
        None => "local".to_string(),
    }
}

/// Nombres de carpeta de skill ya ocupados, mirando TODOS los buckets.
///
/// El slug tiene que ser único en todo el store aunque las carpetas estén separadas por
/// repo, porque es también el nombre del symlink dentro del proyecto: dos skills llamadas
/// `testing` attacheadas a la misma tab pelearían por `.claude/skills/testing`. Al
/// desambiguar acá, `slug_from_source_path` sigue siendo una función pura del path y los
/// tres lugares que derivan el slug (crear, reconciliar, verificar) no pueden discrepar.
pub(super) fn taken_slugs(skills_dir: &Path) -> std::collections::HashSet<String> {
    let mut taken = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(skills_dir) else { return taken };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Una carpeta con SKILL.md es una skill del layout viejo (plana, sin bucket); si no
        // lo tiene, es un bucket y las skills están un nivel más adentro.
        if entry.path().join("SKILL.md").exists() {
            taken.insert(name);
            continue;
        }
        if let Ok(inner) = std::fs::read_dir(entry.path()) {
            for skill in inner.flatten() {
                if skill.path().is_dir() {
                    taken.insert(skill.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    taken
}

/// Cuerpo real de `install_skill`, separado del comando Tauri para poder reusarlo desde
/// `marketplace::install_marketplace_skill` (que arma un `source_file` local temporal a
/// partir de una skill remota descargada, no de una elegida a mano por el usuario).
pub(crate) fn install_skill_internal(
    source_file: &str,
    overrides: Option<SkillFrontmatterInput>,
    origin: SkillOrigin,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let (file, source) = resolve_skill_file(source_file)?;
    let Some((parsed_meta, original_content)) = scan_skill_file(&file) else {
        return Err(format!("No se pudo leer {source_file}"));
    };

    // Si el usuario completó metadata faltante en el formulario de instalación, esos
    // valores reemplazan el frontmatter original al completo (el frontend siempre manda
    // el objeto ya fusionado: lo que vino del archivo + lo que el usuario tipeó).
    let meta: SkillFrontmatter = match overrides {
        Some(o) => o.into(),
        None => parsed_meta,
    };

    let folder_basename = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let name = meta.name.clone().unwrap_or(folder_basename);

    let skills_dir = resolve_skills_dir(db)?;
    let bucket_dir = skills_dir.join(bucket_for_origin(origin));
    std::fs::create_dir_all(&bucket_dir).map_err(|e| e.to_string())?;

    // El sufijo solo aparece cuando el nombre ya está tomado por OTRA skill del store —
    // que es justo el caso en que hace falta, porque las dos competirían por el mismo
    // symlink dentro del proyecto.
    let taken = taken_slugs(&skills_dir);
    let base = slugify(&name);
    let mut slug = base.clone();
    let mut suffix = 1;
    while taken.contains(&slug) || bucket_dir.join(&slug).exists() {
        suffix += 1;
        slug = format!("{base}-{suffix}");
    }
    let dest = bucket_dir.join(&slug);

    copy_dir_recursive(&source, &dest).map_err(|e| e.to_string())?;

    // Si se completó metadata (o simplemente para normalizar), reescribimos SKILL.md en
    // la copia global con el frontmatter final — "guardar el archivo modificado" pedido
    // por el usuario. El body (contenido debajo del frontmatter) se preserva intacto.
    let (_, body) = split_frontmatter(&original_content);
    let mut meta_to_write = meta.clone();
    meta_to_write.name = Some(name.clone());
    let final_content = render_skill_md(&meta_to_write, &body);
    std::fs::write(dest.join("SKILL.md"), &final_content).map_err(|e| e.to_string())?;

    let now = now_ts();
    let id = Uuid::new_v4().to_string();
    let info = SkillInfo {
        id: id.clone(),
        name,
        description: meta.description,
        version: meta.version.unwrap_or_else(|| "0.1.0".to_string()),
        categories: meta.categories,
        compatible_agents: meta.compatible_agents,
        compatible_versions: meta.compatible_versions,
        author: meta.author,
        license: meta.license,
        homepage: meta.homepage,
        source_path: dest.to_string_lossy().to_string(),
        registry_id: origin.map(|(id, _)| id.to_string()),
        registry_name: origin.map(|(_, name)| name.to_string()),
        installed_at: now,
        updated_at: now,
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO skills (id, name, description, version, categories, compatible_agents, compatible_versions, author, license, homepage, source_path, installed_at, updated_at, registry_id, registry_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)",
        rusqlite::params![
            info.id,
            info.name,
            info.description,
            info.version,
            serde_json::to_string(&info.categories).unwrap_or_default(),
            serde_json::to_string(&info.compatible_agents).unwrap_or_default(),
            serde_json::to_string(&info.compatible_versions).unwrap_or_default(),
            info.author,
            info.license,
            info.homepage,
            info.source_path,
            now,
            info.registry_id,
            info.registry_name,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(info)
}

/// Borra todas las skills instaladas desde un repo. Best-effort por skill: que una falle
/// (carpeta ya borrada a mano, symlink en conflicto) no debe dejar el resto a medias ni
/// abortar el borrado del repositorio.
pub(crate) fn delete_skills_of_registry(
    registry_id: &str,
    db: &DbConnection,
) -> Result<usize, String> {
    let ids: Vec<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM skills WHERE registry_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([registry_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut removed = 0;
    for id in &ids {
        if delete_skill_internal(id, db).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn delete_skill(skill_id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    delete_skill_internal(&skill_id, &db)
}

pub(super) fn delete_skill_internal(skill_id: &str, db: &DbConnection) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let source_path: String = conn
        .query_row("SELECT source_path FROM skills WHERE id = ?1", [skill_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    // Los symlinks físicos de cada attachment hay que removerlos aparte: el cascade de la
    // FK solo limpia la DB, no el filesystem. Se anotan los directorios afectados ANTES de
    // borrar la fila (después ya no hay `project_skills` desde donde derivarlos) y se
    // reconcilian una vez que la skill dejó de existir.
    let affected = collect_linked_tabs(&conn, skill_id)?;

    conn.execute("DELETE FROM skills WHERE id = ?1", [skill_id]).map_err(|e| e.to_string())?;
    reconcile_link_dirs(&conn, &affected);
    drop(conn);

    let _ = std::fs::remove_dir_all(&source_path);

    // Si era la última skill de su repo, el bucket queda vacío — se limpia para que el
    // directorio de skills no se llene de carpetas de repos que ya no tienen nada.
    // `remove_dir` falla si no está vacío, que es exactamente la condición que queremos.
    if let Some(bucket) = Path::new(&source_path).parent() {
        let _ = std::fs::remove_dir(bucket);
    }

    Ok(())
}

