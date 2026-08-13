//! Comandos de agentes: qué TUIs hay, con qué cuentas y con qué pre-lanzamiento.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;

/// Qué se puede pasar en `--agent`: los detectados en el PATH más las TUIs que el usuario
/// registró a mano. Sin esto, el id correcto había que adivinarlo.
/// Cuentas de una TUI, tal como las guarda `accounts`.
fn accounts_of(app: &AppHandle) -> Result<Vec<(String, String, String)>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, agent_id, name FROM agent_accounts ORDER BY agent_id, name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Nombre de cuenta → id, comprobando que sea de ESE agente.
///
/// Que sea del agente correcto no es un detalle: los perfiles no son intercambiables (cada
/// TUI usa su propia variable de entorno), así que abrir Claude con la cuenta de OpenCode
/// no daría un error visible — daría una tab que ignora la cuenta en silencio.
pub(super) fn resolve_account_id(app: &AppHandle, agent_id: &str, name: &str) -> Result<String, String> {
    match_account_id(&accounts_of(app)?, agent_id, name)
}

/// El emparejamiento en sí, sobre las cuentas ya leídas. Separado para poder probarlo.
pub(crate) fn match_account_id(
    accounts: &[(String, String, String)],
    agent_id: &str,
    name: &str,
) -> Result<String, String> {
    let needle = name.to_lowercase();
    let of_agent: Vec<&(String, String, String)> =
        accounts.iter().filter(|(_, a, _)| a == agent_id).collect();

    if let Some((id, _, _)) = of_agent
        .iter()
        .find(|(id, _, n)| n.to_lowercase() == needle || id.to_lowercase() == needle)
    {
        return Ok(id.clone());
    }

    // Una cuenta que existe pero es de otra TUI es el error más fácil de cometer, así que
    // se distingue de "no existe" en vez de dar el mismo mensaje genérico.
    if let Some((_, otro, _)) = accounts
        .iter()
        .find(|(_, _, n)| n.to_lowercase() == needle)
    {
        return Err(format!(
            "La cuenta '{name}' es de '{otro}', no de '{agent_id}'"
        ));
    }

    let names: Vec<&str> = of_agent.iter().map(|(_, _, n)| n.as_str()).collect();
    if names.is_empty() {
        Err(format!(
            "'{agent_id}' no tiene ninguna cuenta creada. Se crean desde Configuración › Cuentas; 'ccode accounts' las lista"
        ))
    } else {
        Err(format!(
            "'{agent_id}' no tiene ninguna cuenta llamada '{name}'. Tiene: {}",
            names.join(", ")
        ))
    }
}

/// Comandos de pre-lanzamiento guardados: qué se puede poner en `--pre-preset`.
pub(super) fn prelaunch_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, command FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "command": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let presets: Vec<Value> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    Ok(json!({ "presets": presets }))
}

/// Convierte los pasos que mandó la CLI en los que entiende el frontend
/// (`{"command":…}` / `{"presetId":…}`), conservando el orden.
///
/// Tres formas de entrada, y cada una existe por algo:
///
/// - `{"pre":…}` — lo que manda `--pre`. **Ambiguo a propósito**: el usuario escribe una
///   sola cosa y acá se decide si era el nombre de un guardado o un comando literal. La
///   resolución vive de este lado porque es donde está la base.
/// - `{"presetName":…}` — `--pre-preset`. Exige que exista; sirve cuando un guardado se
///   llama igual que un comando que querés correr tal cual.
/// - `{"command":…}` — literal siempre. Es lo que llega por `--json-args`.
pub(super) fn resolve_prelaunch_steps(app: &AppHandle, steps: &[Value]) -> Result<Vec<Value>, String> {
    let presets = prelaunch_presets(app)?;
    steps
        .iter()
        .map(|step| {
            if let Some(cmd) = step.get("command").and_then(|v| v.as_str()) {
                return Ok(json!({ "command": cmd }));
            }
            if let Some(text) = step.get("pre").and_then(|v| v.as_str()) {
                // Un guardado con ese nombre gana sobre el literal: si el usuario se tomó
                // el trabajo de guardarlo, escribirlo es pedirlo.
                return Ok(match match_preset_id(&presets, text) {
                    Ok(id) => json!({ "presetId": id }),
                    Err(_) => json!({ "command": text }),
                });
            }
            let name = step
                .get("presetName")
                .and_then(|v| v.as_str())
                .ok_or("Paso de pre-lanzamiento sin comando ni nombre de guardado")?;
            Ok(json!({ "presetId": match_preset_id(&presets, name)? }))
        })
        .collect()
}

/// `(id, nombre)` de los comandos guardados.
fn prelaunch_presets(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM prelaunch_presets ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Nombre de preset → id. Separado de la lectura para poder probarlo.
pub(crate) fn match_preset_id(presets: &[(String, String)], name: &str) -> Result<String, String> {
    let needle = name.trim().to_lowercase();
    if let Some((id, _)) = presets.iter().find(|(_, n)| n.to_lowercase() == needle) {
        return Ok(id.clone());
    }
    if presets.is_empty() {
        return Err(format!(
            "No hay ningún comando de pre-lanzamiento guardado llamado '{name}'. \
             Se crean en Configuración → Pre-lanzamiento."
        ));
    }
    let names: Vec<&str> = presets.iter().map(|(_, n)| n.as_str()).collect();
    Err(format!(
        "No existe un comando de pre-lanzamiento llamado '{name}'. Hay: {}",
        names.join(", ")
    ))
}

/// Cuentas creadas, agrupadas por TUI. La cuenta principal no se lista: no es una cuenta
/// gestionada por la app, es "no pasar `--account`".
pub(super) fn account_list(app: &AppHandle) -> Result<Value, String> {
    let accounts: Vec<Value> = accounts_of(app)?
        .into_iter()
        .map(|(id, agent_id, name)| json!({ "id": id, "agent": agent_id, "name": name }))
        .collect();
    Ok(json!({ "accounts": accounts }))
}

pub(super) fn agent_list(app: &AppHandle) -> Result<Value, String> {
    let detected = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(crate::agents::detect_agents())?;

    let db = db(app)?;
    let custom = crate::agents::list_custom_agents(db)?;

    let builtin: Vec<Value> = detected
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "label": a.label,
                "command": a.command,
                "available": a.available,
                "version": a.version,
                "custom": false,
            })
        })
        .collect();

    let custom: Vec<Value> = custom
        .iter()
        .map(|a| {
            json!({
                "id": a.id,
                "label": a.label,
                "command": a.command,
                // Una TUI custom la declaró el usuario: se asume disponible, la app no
                // sale a comprobar si su binario está en el PATH.
                "available": true,
                "custom": true,
                "resumable": a.resume_args.is_some(),
            })
        })
        .collect();

    let agents = [builtin, custom].concat();
    Ok(json!({ "agents": agents }))
}

