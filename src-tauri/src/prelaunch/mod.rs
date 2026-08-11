//! Comandos que corren ANTES de lanzar el agente, en el mismo proceso.
//!
//! ## Para qué
//!
//! Un agente ejecuta comandos por vos. Si arranca en el entorno equivocado no falla de
//! forma obvia: falla de forma confusa. Sin el venv activo, `pytest` tira
//! `ModuleNotFoundError` y el agente se pone a "arreglar" una dependencia que en realidad
//! está instalada. Esto deja preparar el entorno primero: `conda activate ml`,
//! `nvm use`, `source .venv/bin/activate`, `eval "$(direnv export bash)"`.
//!
//! ## Por qué no se pueden correr como procesos aparte
//!
//! Las variables de entorno se heredan de padre a hijo en el momento del spawn, y en una
//! sola dirección. `conda activate` no es un binario: es una función que muta el entorno
//! del shell que la ejecuta. Corrida en un proceso aparte, su efecto muere con ese proceso
//! y el agente —que no es su hijo— jamás se entera.
//!
//! Por eso la cadena se ejecuta DENTRO del mismo shell que después se convierte en el
//! agente (ver `terminal::pty_manager::launch_script`).
//!
//! ## El modelo
//!
//! Una cadena es una lista ORDENADA de pasos, y el orden es semántico: `nvm use 18` tiene
//! que correr antes de cualquier cosa que dependa de npm. Cada paso es o un comando suelto
//! escrito en el momento, o una referencia a un preset guardado en Configuración.
//!
//! Se guarda la REFERENCIA al preset y no su texto ya resuelto, por el mismo motivo que
//! con las cuentas: si después editás el preset, las tabs restauradas usan la versión
//! nueva en vez de quedarse con una copia vieja. Y si el preset fue borrado, lanzar
//! **falla con mensaje** en vez de arrancar sin él — arrancar en el entorno equivocado y
//! en silencio es justo lo que esta feature viene a evitar.

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};

/// Un paso de la cadena: o un preset guardado, o un comando escrito a mano.
///
/// `untagged` para que el JSON guardado sea plano —`{"presetId":"…"}` / `{"command":"…"}`—
/// en vez de llevar el nombre de la variante como envoltorio. Es lo que se escribe en la
/// base y lo que manda el frontend, así que conviene que se lea sin traducción mental.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum PrelaunchStep {
    Preset {
        #[serde(rename = "presetId")]
        preset_id: String,
    },
    Command {
        command: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrelaunchPreset {
    pub id: String,
    /// Cómo lo ve el usuario, ej. "entorno conda".
    pub name: String,
    pub command: String,
    pub created_at: i64,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Nombres vacíos o solo espacios harían un preset imposible de elegir en la UI y de
/// nombrar desde `ccode --pre-preset`.
pub fn validate_preset(name: &str, command: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    if command.trim().is_empty() {
        return Err("El comando no puede estar vacío".into());
    }
    Ok(())
}

/// Convierte la cadena guardada en los comandos concretos a ejecutar, en orden.
///
/// Toma `&Connection` y no `&DbConnection` a propósito: así se puede llamar desde código
/// que YA tiene el lock tomado sin caer en un deadlock (el mutex de la app no es
/// reentrante). Ver `accounts::dir_for_conn`, que existe por lo mismo.
pub fn resolve_conn(
    conn: &rusqlite::Connection,
    steps: &[PrelaunchStep],
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(steps.len());
    for step in steps {
        match step {
            PrelaunchStep::Command { command } => {
                let command = command.trim();
                if !command.is_empty() {
                    out.push(command.to_string());
                }
            }
            PrelaunchStep::Preset { preset_id } => {
                let found: Option<(String, String)> = conn
                    .query_row(
                        "SELECT name, command FROM prelaunch_presets WHERE id = ?1",
                        [preset_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok();
                // Falla en vez de omitir: un paso que desaparece en silencio deja al
                // agente corriendo fuera del entorno que el usuario pidió.
                let (_, command) = found.ok_or_else(|| {
                    "Un comando de pre-lanzamiento guardado ya no existe. Revisá la cadena \
                     en Configuración → Pre-lanzamiento."
                        .to_string()
                })?;
                let command = command.trim();
                if !command.is_empty() {
                    out.push(command.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// Igual que `resolve_conn`, tomando el lock. No llamar con el lock ya tomado.
pub fn resolve(db: &DbConnection, steps: &[PrelaunchStep]) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    resolve_conn(&conn, steps)
}

/// Lo que invoca el frontend justo antes de spawnear, igual que `agent_account_env`: si un
/// preset fue borrado mientras la tab estaba guardada, se entera acá y no arranca.
#[tauri::command]
pub fn resolve_prelaunch(
    steps: Vec<PrelaunchStep>,
    db: tauri::State<DbConnection>,
) -> Result<Vec<String>, String> {
    resolve(&db, &steps)
}

#[tauri::command]
pub fn list_prelaunch_presets(
    db: tauri::State<DbConnection>,
) -> Result<Vec<PrelaunchPreset>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, command, created_at FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PrelaunchPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Crea o actualiza. `id` vacío/ausente = alta.
#[tauri::command]
pub fn save_prelaunch_preset(
    id: Option<String>,
    name: String,
    command: String,
    db: tauri::State<DbConnection>,
) -> Result<PrelaunchPreset, String> {
    let name = name.trim().to_string();
    let command = command.trim().to_string();
    validate_preset(&name, &command)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    let id = id.filter(|s| !s.is_empty());
    let preset = match id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE prelaunch_presets SET name = ?1, command = ?2 WHERE id = ?3",
                    rusqlite::params![name, command, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("Ese comando guardado ya no existe".into());
            }
            let created_at = conn
                .query_row("SELECT created_at FROM prelaunch_presets WHERE id = ?1", [&id], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())?;
            PrelaunchPreset { id, name, command, created_at }
        }
        None => {
            let preset = PrelaunchPreset {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                command,
                created_at: now_ts(),
            };
            conn.execute(
                "INSERT INTO prelaunch_presets (id, name, command, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    preset.id,
                    preset.name,
                    preset.command,
                    preset.created_at
                ],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    format!("Ya existe un comando guardado llamado '{}'", preset.name)
                } else {
                    e.to_string()
                }
            })?;
            preset
        }
    };
    Ok(preset)
}

#[tauri::command]
pub fn delete_prelaunch_preset(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM prelaunch_presets WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Serializa la cadena para guardarla en `tabs`/`session_history`. Una cadena vacía se
/// guarda como `[]` y no como NULL, para que leerla nunca tenga que distinguir los dos.
pub fn steps_to_json(steps: &[PrelaunchStep]) -> String {
    serde_json::to_string(steps).unwrap_or_else(|_| "[]".into())
}

/// Lee la cadena guardada. Un JSON corrupto o de una versión futura se degrada a cadena
/// vacía en vez de impedir que la tab se restaure.
pub fn steps_from_json(raw: &str) -> Vec<PrelaunchStep> {
    serde_json::from_str(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE prelaunch_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
             command TEXT NOT NULL, created_at INTEGER NOT NULL);
             INSERT INTO prelaunch_presets VALUES ('p1', 'entorno conda', 'conda activate ml', 0);
             INSERT INTO prelaunch_presets VALUES ('p2', 'node del proyecto', 'nvm use', 0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn la_cadena_conserva_el_orden_pedido() {
        let steps = vec![
            PrelaunchStep::Preset { preset_id: "p2".into() },
            PrelaunchStep::Command { command: "source .venv/bin/activate".into() },
            PrelaunchStep::Preset { preset_id: "p1".into() },
        ];
        assert_eq!(
            resolve_conn(&db(), &steps).unwrap(),
            vec!["nvm use", "source .venv/bin/activate", "conda activate ml"]
        );
    }

    #[test]
    fn un_preset_borrado_hace_fallar_el_lanzamiento() {
        let steps = vec![PrelaunchStep::Preset { preset_id: "fantasma".into() }];
        let err = resolve_conn(&db(), &steps).unwrap_err();
        assert!(err.contains("ya no existe"), "mensaje poco claro: {err}");
    }

    #[test]
    fn los_pasos_vacios_no_ensucian_la_cadena() {
        // Un campo de texto que quedó en blanco no tiene por qué producir un `&&` colgando.
        let steps = vec![
            PrelaunchStep::Command { command: "  ".into() },
            PrelaunchStep::Command { command: " nvm use ".into() },
        ];
        assert_eq!(resolve_conn(&db(), &steps).unwrap(), vec!["nvm use"]);
    }

    #[test]
    fn una_cadena_vacia_resuelve_a_nada() {
        assert!(resolve_conn(&db(), &[]).unwrap().is_empty());
    }

    /// El formato en disco es parte del contrato con el frontend y con `ccode`: si deja
    /// de ser plano, las cadenas ya guardadas dejan de leerse.
    #[test]
    fn el_json_guardado_es_plano() {
        let json = steps_to_json(&[
            PrelaunchStep::Preset { preset_id: "p1".into() },
            PrelaunchStep::Command { command: "nvm use".into() },
        ]);
        assert_eq!(json, r#"[{"presetId":"p1"},{"command":"nvm use"}]"#);
    }

    #[test]
    fn la_cadena_sobrevive_al_viaje_por_json() {
        let steps = vec![
            PrelaunchStep::Preset { preset_id: "p1".into() },
            PrelaunchStep::Command { command: "nvm use".into() },
        ];
        assert_eq!(steps_from_json(&steps_to_json(&steps)), steps);
    }

    #[test]
    fn un_json_corrupto_no_impide_restaurar_la_tab() {
        assert!(steps_from_json("{no es json").is_empty());
        assert!(steps_from_json("").is_empty());
    }

    #[test]
    fn no_se_aceptan_presets_sin_nombre_ni_comando() {
        assert!(validate_preset("  ", "nvm use").is_err());
        assert!(validate_preset("node", "  ").is_err());
        assert!(validate_preset("node", "nvm use").is_ok());
    }
}
