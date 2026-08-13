//! Instalar y desinstalar skills: la copia global bajo el directorio configurado.

use rusqlite::OptionalExtension;
use std::path::Path;
use uuid::Uuid;

use crate::database::DbConnection;

use super::files::{copy_dir_recursive, resolve_skill_file, scan_skill_file, slugify};
use super::frontmatter::{render_skill_md, split_frontmatter};
use super::links::reconcile_link_dirs;
use super::settings::resolve_skills_dir;
use super::store::collect_linked_tabs;
use crate::util::now_ts;

use super::types::{
    missing_fields, SkillFrontmatter, SkillFrontmatterInput, SkillInfo, SkillPreview,
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

/// De dónde viene una skill que se está instalando. `None` = instalación manual desde un
/// archivo del disco.
///
/// Lleva el id de la ENTRADA además del repo porque el repo solo no identifica nada: dos
/// skills pueden llamarse igual, ser de autores distintos y venir del mismo repositorio
/// (el directorio de skills.sh lista publicadores distintos bajo un único "repo"). El par
/// (repo, entrada) sí es único — para skills.sh la entrada es `owner/repo/slug`, que ya
/// lleva el autor adentro.
#[derive(Clone, Copy)]
pub(crate) struct SkillOrigin<'a> {
    pub registry_id: &'a str,
    pub registry_name: &'a str,
    /// Id de la entrada dentro del repositorio.
    pub skill_id: &'a str,
}

/// Carpeta donde vive la copia global de una skill, dentro del directorio de skills.
///
/// Una por repositorio, más `local` para las instaladas a mano. Dos repos pueden traer
/// skills con el mismo nombre y funcionalidad distinta (`testing` de uno no es `testing`
/// del otro), así que mezclarlas en un solo nivel las hacía competir por la misma carpeta.
pub(super) fn bucket_for_origin(origin: Option<SkillOrigin>) -> String {
    match origin {
        Some(o) => slugify(o.registry_name),
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
    origin: Option<SkillOrigin>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    // ¿Ya está instalada ESTA entrada de ESTE repositorio? Entonces reinstalar es
    // actualizar, no duplicar: sin esto se acumulaban `testing`, `testing-2`, `testing-3`
    // de la misma fuente, todas idénticas y compitiendo por el mismo symlink.
    //
    // Se compara por (repo, entrada) y nunca por nombre: dos skills homónimas pueden ser
    // de autores distintos y son cosas distintas, así que instalar una NO puede pisar a la
    // otra (ver `SkillOrigin`).
    if let Some(o) = origin {
        let existing: Option<(String, String)> = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT id, source_path FROM skills WHERE registry_id = ?1 AND origin_skill_id = ?2",
                rusqlite::params![o.registry_id, o.skill_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        };
        if let Some((existing_id, existing_path)) = existing {
            return update_installed(&existing_id, &existing_path, source_file, overrides, db);
        }
    }


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
        registry_id: origin.map(|o| o.registry_id.to_string()),
        registry_name: origin.map(|o| o.registry_name.to_string()),
        origin_skill_id: origin.map(|o| o.skill_id.to_string()),
        installed_at: now,
        updated_at: now,
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO skills (id, name, description, version, categories, compatible_agents, compatible_versions, author, license, homepage, source_path, installed_at, updated_at, registry_id, registry_name, origin_skill_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15)",
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
            info.origin_skill_id,
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

/// Reemplaza el contenido de una skill ya instalada con el de su origen, conservando su
/// fila (y con ella sus attachments, que cuelgan del id).
///
/// Es lo que hace que "instalar" una skill que ya está sea "actualizarla": borrar y volver
/// a insertar le cambiaría el id, y `project_skills.skill_id` cascadea — el usuario
/// perdería todos los attachments de esa skill a cambio de nada.
fn update_installed(
    skill_id: &str,
    dest: &str,
    source_file: &str,
    overrides: Option<SkillFrontmatterInput>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let (file, source) = resolve_skill_file(source_file)?;
    let Some((parsed_meta, original_content)) = scan_skill_file(&file) else {
        return Err(format!("No se pudo leer {source_file}"));
    };
    let meta: SkillFrontmatter = match overrides {
        Some(o) => o.into(),
        None => parsed_meta,
    };

    // Se reemplaza la carpeta entera: los archivos que la versión nueva ya no trae no
    // pueden sobrevivir, o lo instalado dejaría de ser igual a lo que ofrece el repo.
    let dest_path = Path::new(dest);
    let _ = std::fs::remove_dir_all(dest_path);
    copy_dir_recursive(&source, dest_path).map_err(|e| e.to_string())?;

    let name = meta
        .name
        .clone()
        .or_else(|| source.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "skill".to_string());
    let (_, body) = split_frontmatter(&original_content);
    let mut meta_to_write = meta.clone();
    meta_to_write.name = Some(name.clone());
    std::fs::write(dest_path.join("SKILL.md"), render_skill_md(&meta_to_write, &body))
        .map_err(|e| e.to_string())?;

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE skills SET name = ?1, description = ?2, version = ?3, categories = ?4,
                 compatible_agents = ?5, compatible_versions = ?6, author = ?7, license = ?8,
                 homepage = ?9, updated_at = ?10
             WHERE id = ?11",
            rusqlite::params![
                name,
                meta.description,
                meta.version.clone().unwrap_or_else(|| "0.1.0".to_string()),
                serde_json::to_string(&meta.categories).unwrap_or_default(),
                serde_json::to_string(&meta.compatible_agents).unwrap_or_default(),
                serde_json::to_string(&meta.compatible_versions).unwrap_or_default(),
                meta.author,
                meta.license,
                meta.homepage,
                now_ts(),
                skill_id,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    super::links::fetch_skill_row(&conn, skill_id)
}
