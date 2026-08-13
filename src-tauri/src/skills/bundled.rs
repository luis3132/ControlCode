//! Skills que vienen con la app y se instalan solas al arrancar.
//!
//! Hoy es una sola: `controlcode-orchestrator`, la que le enseña a un agente externo a
//! manejar la app por la CLI. Tenerla en el repo y pedirle al usuario que la instale a
//! mano desde el Marketplace no tenía sentido: es *nuestra*, la versión correcta es
//! siempre la que trae el binario que está corriendo, y sin ella el modo orquestador
//! (Fases 8 y 9) queda invisible.
//!
//! Tres decisiones que definen el comportamiento:
//!
//! 1. **Se actualiza sola cuando cambia de versión.** Si no, una app nueva quedaría con la
//!    copia vieja de la skill describiendo comandos que ya no existen — que es exactamente
//!    lo que pasó al pasar la skill de 1.0.0 a 1.1.0 en la Fase 9.
//! 2. **Si el usuario la borra, se queda borrada.** Reinstalarla en cada arranque
//!    convertiría el botón de borrar en un chiste. Se recuerda en `settings` qué versión
//!    se aprovisionó, así que "no está y ya la instalamos" se distingue de "nunca se
//!    instaló". Una versión NUEVA sí vuelve a ofrecerse.
//! 3. **Nada de esto puede impedir que la app arranque.** Todos los fallos se registran
//!    por stderr y se siguen de largo: sin la skill la app funciona igual.

use super::files::{copy_dir_recursive, scan_skill_file};
use super::install::install_skill_internal;
use crate::util::now_ts;
use crate::database::DbConnection;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Carpetas dentro de `skills/` del repo que se empaquetan con la app.
pub(super) const BUNDLED: &[&str] = &["controlcode-orchestrator"];

/// Se guarda como si viniera de un repositorio llamado "Control Code": le da su propio
/// bucket en el store (no se mezcla con las que el usuario instaló a mano) y hace que la
/// UI muestre de dónde salió. No hay ninguna fila en `registries` con este id, y no hace
/// falta: la columna está desnormalizada justamente para eso.
const ORIGIN_ID: &str = "controlcode-builtin";
const ORIGIN_NAME: &str = "Control Code";

/// Clave en `settings` con lo ya aprovisionado: `{ "<carpeta>": { version, path } }`.
const PROVISIONED_KEY: &str = "bundled_skills";

#[derive(Serialize, Deserialize, Clone)]
pub(super) struct Provisioned {
    pub(super) version: String,
    /// Ruta de la copia global. Es la que identifica la fila en `skills` (la columna es
    /// UNIQUE), y sobrevive a que el usuario renombre la skill.
    pub(super) path: String,
}

type ProvisionedMap = HashMap<String, Provisioned>;

/// Qué corresponde hacer con una skill incluida en este arranque.
#[derive(PartialEq, Eq, Debug)]
pub(super) enum Action {
    /// Copiarla e insertarla: nunca se instaló, o la versión que trae la app es nueva
    /// respecto de la última que se aprovisionó.
    Install,
    /// Está instalada pero con otra versión: pisar los archivos y actualizar la fila.
    Update,
    /// No tocar nada: o ya está al día, o el usuario la borró a propósito.
    Skip,
}

/// La regla completa, aislada del disco y de la base para poder probarla.
///
/// `installed_version` es `None` cuando la fila ya no está — que puede significar dos
/// cosas muy distintas, y por eso hace falta `previous`: si coincide con la versión que
/// trae la app, es que la instalamos y el usuario la borró (se respeta); si no coincide o
/// no hay registro, es una instalación genuinamente pendiente.
pub(super) fn decide(previous: Option<&Provisioned>, installed_version: Option<&str>, bundled: &str) -> Action {
    match installed_version {
        Some(v) if v == bundled => Action::Skip,
        Some(_) => Action::Update,
        None if previous.is_some_and(|p| p.version == bundled) => Action::Skip,
        None => Action::Install,
    }
}

/// Instala o actualiza las skills incluidas. Se llama una vez, al arrancar la app.
pub fn ensure_bundled_skills(app: &AppHandle, db: &DbConnection) {
    for name in BUNDLED {
        let result = match bundled_dir(app, name) {
            Some(source) => ensure_one(db, name, &source),
            None => Err("no se encontró la carpeta empaquetada".to_string()),
        };
        if let Err(e) = result {
            eprintln!("[controlcode] no se pudo preparar la skill incluida '{name}': {e}");
        }
    }
}

/// Separado de la resolución de rutas para poder ejercitarlo sin un `AppHandle`: acá está
/// todo lo que toca el disco del usuario y su base, que es lo que vale la pena probar.
pub(super) fn ensure_one(db: &DbConnection, name: &str, source: &Path) -> Result<(), String> {
    let skill_md = source.join("SKILL.md");
    let (meta, _) = scan_skill_file(&skill_md)
        .ok_or_else(|| format!("no se pudo leer {}", skill_md.display()))?;
    let version = meta.version.clone().unwrap_or_else(|| "0.1.0".to_string());

    let mut provisioned = read_provisioned(db);
    let previous = provisioned.get(name).cloned();

    // ¿La copia que instalamos sigue existiendo en la base?
    let installed = previous.as_ref().and_then(|p| find_installed(db, &p.path));

    match decide(previous.as_ref(), installed.as_ref().map(|(_, v)| v.as_str()), &version) {
        Action::Skip => return Ok(()),

        Action::Update => {
            let (id, old_version) = installed.expect("Update solo sale con fila instalada");
            let dest = PathBuf::from(&previous.expect("hay fila, hubo registro").path);
            update_in_place(db, &id, source, &dest, &meta, &version)?;
            provisioned.entry(name.to_string()).and_modify(|e| e.version = version.clone());
            write_provisioned(db, &provisioned)?;
            eprintln!("[controlcode] skill incluida '{name}' actualizada {old_version} → {version}");
        }

        Action::Install => {
            let info = install_skill_internal(
                &skill_md.to_string_lossy(),
                None,
                Some(crate::skills::SkillOrigin {
                    registry_id: ORIGIN_ID,
                    registry_name: ORIGIN_NAME,
                    // La skill que viaja con la app es su propia entrada: no hay un
                    // repositorio detrás del que pueda venir otra con el mismo nombre.
                    skill_id: name,
                }),
                db,
            )?;
            provisioned.insert(
                name.to_string(),
                Provisioned { version: version.clone(), path: info.source_path },
            );
            write_provisioned(db, &provisioned)?;
            eprintln!("[controlcode] skill incluida '{name}' instalada (v{version})");
        }
    }

    Ok(())
}

/// Dónde quedó la carpeta de la skill según cómo se esté ejecutando la app.
///
/// En un bundle la pone el bundler en el directorio de recursos; en `tauri dev` queda al
/// lado del ejecutable. El último candidato es el repo mismo: cubre correr el binario a
/// mano desde `target/debug` sin pasar por Tauri, que es como se prueba casi siempre.
fn bundled_dir(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("skills").join(name));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("skills").join(name));
        // macOS: el ejecutable vive en `Contents/MacOS/`, los recursos en `Contents/Resources/`.
        candidates.push(exe_dir.join("../Resources/skills").join(name));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills").join(name),
    );

    candidates.into_iter().find(|p| p.join("SKILL.md").is_file())
}

/// `(id, version)` de la skill instalada en `path`, si sigue estando.
fn find_installed(db: &DbConnection, path: &str) -> Option<(String, String)> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT id, version FROM skills WHERE source_path = ?1",
        [path],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// Reemplaza los archivos de la copia global y actualiza la fila.
///
/// Se borra el destino antes de copiar: si la versión nueva sacó un archivo, dejarlo
/// suelto haría que la skill instalada no fuera igual a la que trae la app.
fn update_in_place(
    db: &DbConnection,
    skill_id: &str,
    source: &Path,
    dest: &Path,
    meta: &super::types::SkillFrontmatter,
    version: &str,
) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    copy_dir_recursive(source, dest).map_err(|e| e.to_string())?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE skills
            SET version = ?1, description = ?2, categories = ?3, compatible_agents = ?4,
                updated_at = ?5
          WHERE id = ?6",
        rusqlite::params![
            version,
            meta.description,
            serde_json::to_string(&meta.categories).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&meta.compatible_agents).unwrap_or_else(|_| "[]".into()),
            now_ts(),
            skill_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_provisioned(db: &DbConnection) -> ProvisionedMap {
    crate::database::get_setting(db, PROVISIONED_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_provisioned(db: &DbConnection, map: &ProvisionedMap) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    crate::database::set_setting(db, PROVISIONED_KEY, &json)
}
