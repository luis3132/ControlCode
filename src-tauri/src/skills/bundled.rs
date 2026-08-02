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

use super::{copy_dir_recursive, install_skill_internal, now_ts, scan_skill_file};
use crate::database::DbConnection;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Carpetas dentro de `skills/` del repo que se empaquetan con la app.
const BUNDLED: &[&str] = &["controlcode-orchestrator"];

/// Se guarda como si viniera de un repositorio llamado "Control Code": le da su propio
/// bucket en el store (no se mezcla con las que el usuario instaló a mano) y hace que la
/// UI muestre de dónde salió. No hay ninguna fila en `registries` con este id, y no hace
/// falta: la columna está desnormalizada justamente para eso.
const ORIGIN_ID: &str = "controlcode-builtin";
const ORIGIN_NAME: &str = "Control Code";

/// Clave en `settings` con lo ya aprovisionado: `{ "<carpeta>": { version, path } }`.
const PROVISIONED_KEY: &str = "bundled_skills";

#[derive(Serialize, Deserialize, Clone)]
struct Provisioned {
    version: String,
    /// Ruta de la copia global. Es la que identifica la fila en `skills` (la columna es
    /// UNIQUE), y sobrevive a que el usuario renombre la skill.
    path: String,
}

type ProvisionedMap = HashMap<String, Provisioned>;

/// Qué corresponde hacer con una skill incluida en este arranque.
#[derive(PartialEq, Eq, Debug)]
enum Action {
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
fn decide(previous: Option<&Provisioned>, installed_version: Option<&str>, bundled: &str) -> Action {
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
fn ensure_one(db: &DbConnection, name: &str, source: &Path) -> Result<(), String> {
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
                Some((ORIGIN_ID, ORIGIN_NAME)),
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
    meta: &super::SkillFrontmatter,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(version: &str) -> Provisioned {
        Provisioned { version: version.into(), path: "/skills/control-code/orq".into() }
    }

    /// El arranque normal: ya está instalada y al día. Tiene que ser un no-op — si no,
    /// cada apertura de la app reescribiría archivos por gusto.
    #[test]
    fn an_up_to_date_skill_is_left_alone() {
        assert_eq!(decide(Some(&record("1.1.0")), Some("1.1.0"), "1.1.0"), Action::Skip);
    }

    #[test]
    fn a_first_run_installs_it() {
        assert_eq!(decide(None, None, "1.1.0"), Action::Install);
    }

    /// Lo que motivó todo esto: la app pasó a traer 1.1.0 y en disco quedó la 1.0.0
    /// describiendo comandos que ya no existen.
    #[test]
    fn a_new_version_replaces_the_installed_copy() {
        assert_eq!(decide(Some(&record("1.0.0")), Some("1.0.0"), "1.1.0"), Action::Update);
    }

    /// Si el usuario la borra, borrada se queda. Reinstalarla en cada arranque haría que
    /// el botón de borrar no sirviera para nada.
    #[test]
    fn a_skill_the_user_deleted_does_not_come_back() {
        assert_eq!(decide(Some(&record("1.1.0")), None, "1.1.0"), Action::Skip);
    }

    /// …pero una versión nueva sí se vuelve a ofrecer: es contenido distinto del que el
    /// usuario descartó, y es la única forma de que una app actualizada lo entregue.
    #[test]
    fn a_new_version_is_offered_again_even_after_a_deletion() {
        assert_eq!(decide(Some(&record("1.0.0")), None, "1.1.0"), Action::Install);
    }

    /// Skill de mentira en una carpeta temporal, para no depender de la real.
    fn fake_skill(version: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("cc-bundled-src-{}", uuid::Uuid::new_v4()))
            .join("mi-skill");
        std::fs::create_dir_all(&dir).unwrap();
        write_version(&dir, version);
        dir
    }

    fn write_version(dir: &Path, version: &str) {
        std::fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: mi-skill\ndescription: prueba\nversion: {version}\n\
                 compatible_agents: [claude-code]\n---\n\n# Cuerpo v{version}\n"
            ),
        )
        .unwrap();
    }

    fn test_db() -> (DbConnection, PathBuf) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::super::tests::TEST_SCHEMA).unwrap();
        let store = std::env::temp_dir().join(format!("cc-bundled-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&store).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
            [store.to_string_lossy()],
        )
        .unwrap();
        (std::sync::Arc::new(std::sync::Mutex::new(conn)), store)
    }

    fn installed_rows(db: &DbConnection) -> Vec<(String, String, String)> {
        let conn = db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name, version, source_path FROM skills ORDER BY name")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    /// El ciclo completo contra disco y base: instalar, no duplicar, actualizar y respetar
    /// el borrado. Es el comportamiento que ve el usuario cada vez que abre la app.
    #[test]
    fn the_provisioning_lifecycle() {
        let source = fake_skill("1.0.0");
        let (db, store) = test_db();

        // 1. Primer arranque: se instala.
        ensure_one(&db, "mi-skill", &source).unwrap();
        let rows = installed_rows(&db);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "1.0.0");
        let dest = PathBuf::from(&rows[0].2);
        assert!(dest.join("SKILL.md").is_file(), "la copia global tiene que existir");
        assert!(dest.starts_with(&store), "tiene que quedar dentro del store configurado");
        assert!(
            std::fs::read_to_string(dest.join("SKILL.md")).unwrap().contains("Cuerpo v1.0.0")
        );

        // 2. Arranques siguientes: no se duplica ni se reescribe.
        ensure_one(&db, "mi-skill", &source).unwrap();
        ensure_one(&db, "mi-skill", &source).unwrap();
        assert_eq!(installed_rows(&db).len(), 1, "no puede instalarse de nuevo en cada arranque");

        // 3. La app trae una versión nueva: se pisa la copia y se actualiza la fila.
        write_version(&source, "2.0.0");
        ensure_one(&db, "mi-skill", &source).unwrap();
        let rows = installed_rows(&db);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "2.0.0");
        assert_eq!(rows[0].2, dest.to_string_lossy(), "la ruta no debería moverse");
        assert!(
            std::fs::read_to_string(dest.join("SKILL.md")).unwrap().contains("Cuerpo v2.0.0"),
            "los archivos tienen que quedar los de la versión nueva"
        );

        // 4. El usuario la borra: no vuelve sola.
        db.lock().unwrap().execute("DELETE FROM skills", []).unwrap();
        std::fs::remove_dir_all(&dest).ok();
        ensure_one(&db, "mi-skill", &source).unwrap();
        assert!(installed_rows(&db).is_empty(), "borrada por el usuario, borrada se queda");

        // 5. …pero una versión nueva sí se vuelve a ofrecer.
        write_version(&source, "3.0.0");
        ensure_one(&db, "mi-skill", &source).unwrap();
        assert_eq!(installed_rows(&db).len(), 1);
        assert_eq!(installed_rows(&db)[0].1, "3.0.0");
    }

    /// Los archivos que la versión nueva ya no trae no deben sobrevivir en la copia global:
    /// si no, lo instalado deja de ser igual a lo que trae la app.
    #[test]
    fn an_update_removes_files_the_new_version_dropped() {
        let source = fake_skill("1.0.0");
        let (db, _store) = test_db();
        std::fs::write(source.join("viejo.md"), "sobra").unwrap();

        ensure_one(&db, "mi-skill", &source).unwrap();
        let dest = PathBuf::from(&installed_rows(&db)[0].2);
        assert!(dest.join("viejo.md").is_file());

        std::fs::remove_file(source.join("viejo.md")).unwrap();
        write_version(&source, "2.0.0");
        ensure_one(&db, "mi-skill", &source).unwrap();
        assert!(!dest.join("viejo.md").exists());
    }

    /// La skill del repo tiene que ser instalable: frontmatter parseable y con versión.
    /// Si alguien la edita y rompe el YAML, esto lo dice antes de que se note en runtime
    /// (donde el fallo es silencioso a propósito).
    #[test]
    fn the_bundled_skill_in_the_repo_is_valid() {
        for name in BUNDLED {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills").join(name);
            let skill_md = dir.join("SKILL.md");
            assert!(skill_md.is_file(), "falta {}", skill_md.display());

            let (meta, _) = scan_skill_file(&skill_md).expect("SKILL.md ilegible");
            assert_eq!(meta.name.as_deref(), Some(*name), "el name del frontmatter tiene que coincidir con la carpeta");
            assert!(meta.version.is_some(), "sin version no se puede detectar una actualización");
            assert!(meta.description.is_some(), "la description es lo que lee el agente para decidir usarla");
            assert!(!meta.compatible_agents.is_empty());
        }
    }
}
