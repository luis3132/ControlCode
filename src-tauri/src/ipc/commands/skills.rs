//! Comandos de skills: las instaladas, el marketplace y la instalación.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;
use crate::ipc::protocol::arg_str;

/// Skills instaladas (lo que se le puede pasar a `--skills`) y lo disponible en los repos.
///
/// La forma es deliberadamente flaca: la fila completa de una skill trae fechas, rutas,
/// versiones compatibles y su uso por workspace — nada de eso ayuda a decidir cuál
/// adjuntar, y este listado lo lee un modelo que paga por cada campo (Fase 9). Para el
/// detalle completo está la UI.
pub(super) fn skill_list(app: &AppHandle) -> Result<Value, String> {
    let db = db(app)?;

    let rows = crate::skills::list_skills(db.clone())?;
    let installed_names: std::collections::HashSet<String> =
        rows.iter().map(|s| s.skill.name.to_lowercase()).collect();

    let installed: Vec<Value> = rows
        .iter()
        .map(|s| {
            json!({
                "name": s.skill.name,
                "description": s.skill.description,
                "version": s.skill.version,
                "agents": s.skill.compatible_agents,
                // Cuántos workspaces/tabs la tienen adjuntada ahora mismo.
                "attachedTo": s.used_by.len(),
            })
        })
        .collect();

    // Lo ya instalado se saca de "available": repetirlo sería devolver dos veces la misma
    // skill con distinta forma, y la lista de repos es la más larga de las dos.
    let available: Vec<Value> = crate::marketplace::list_marketplace_skills(None, None, db)?
        .iter()
        .filter(|e| !installed_names.contains(&e.name.to_lowercase()))
        .map(|e| json!({ "name": e.name, "description": e.description, "registry": e.registry_name }))
        .collect();

    Ok(json!({ "installed": installed, "available": available }))
}

/// Un runtime propio para las partes async del marketplace. La CLI se atiende en un hilo
/// que no es el del runtime de Tauri, así que necesita uno donde bloquear.
fn blocking_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
}

/// Busca en los repositorios, incluido el directorio de skills.sh.
///
/// Existe porque skills.sh **no se puede listar**: su CLI solo responde a búsquedas, así
/// que su cache está vacío hasta que alguien busca algo. Sin este comando, todo lo que hay
/// ahí era inalcanzable desde `ccode` — `skill list` no lo mostraba y `skill install` no lo
/// encontraba, salvo por lo que hubiera quedado cacheado de una búsqueda hecha en la UI
/// (o sea, un resultado que dependía de otra pantalla).
pub(super) fn skill_search(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let query = arg_str(args, "query")?;
    let db = db(app)?;

    let matches = |db: tauri::State<'_, crate::database::DbConnection>| {
        crate::marketplace::list_marketplace_skills(Some(query.clone()), None, db)
    };

    // El directorio se consulta SIEMPRE, igual que en el Marketplace: buscar tiene que
    // mostrar todo lo que hay, sin que nadie tenga que pedir cada fuente por separado.
    // Cuesta un proceso `npx` de varios segundos, así que esta llamada tarda — es el precio
    // de que el resultado esté completo.
    let mut sources = vec![json!("repos")];
    let mut remote_error: Option<String> = None;
    match blocking_runtime()?.block_on(crate::marketplace::search_remote_conn(&db, &query)) {
        Ok(()) => sources.push(json!("skills.sh")),
        // Que falle el directorio (sin Node, sin red) no puede tapar lo que los repos
        // propios sí respondieron: se reporta aparte y la búsqueda sigue.
        Err(e) => remote_error = Some(e),
    }

    let found: Vec<Value> = matches(db.clone())?
        .iter()
        .map(|e| {
            json!({
                "name": e.name,
                "description": e.description,
                "registry": e.registry_name,
                "installs": e.installs,
            })
        })
        .collect();

    Ok(json!({
        "found": found,
        "searched": sources,
        "skillsShError": remote_error,
    }))
}

pub(super) fn skill_install(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let skill = arg_str(args, "skill")?;
    let db = db(app)?;
    let wanted = skill.to_lowercase();

    // Se busca la skill por nombre o id entre lo que ofrecen los repos habilitados. Un
    // nombre ambiguo (dos repos con la misma skill) resuelve al de mayor prioridad, que
    // es el mismo criterio que usa el marketplace en la UI.
    let find = || -> Result<Option<crate::marketplace::MarketplaceSkillEntry>, String> {
        Ok(crate::marketplace::list_marketplace_skills(None, None, db.clone())?
            .into_iter()
            .find(|e| e.name.to_lowercase() == wanted || e.id.to_lowercase() == wanted))
    };

    let mut entry = find()?;
    if entry.is_none() {
        // Lo del directorio de skills.sh no está en ningún cache hasta que se lo busca:
        // se intenta por el nombre pedido antes de darlo por inexistente.
        let _ = blocking_runtime()?.block_on(crate::marketplace::search_remote_conn(&db, &skill));
        entry = find()?;
    }

    let entry = entry
        .ok_or_else(|| {
            // El nombre puede venir de la lista `installed` de `ccode skills`, donde no
            // hay nada que instalar. Decir "no se encontró en los repos" ahí sería
            // desconcertante: la skill existe, ya la tiene.
            let already = crate::skills::list_skills(db.clone())
                .map(|rows| rows.iter().any(|s| s.skill.name.to_lowercase() == wanted))
                .unwrap_or(false);
            if already {
                format!("'{skill}' ya está instalada; podés usarla directo en --skills")
            } else {
                format!("No se encontró '{skill}' en los repositorios habilitados (mirá 'ccode skills' o refrescá los repos)")
            }
        })?;

    let registry_id = entry.registry_id.clone();
    let skill_id = entry.id.clone();
    let installed = blocking_runtime()?
        .block_on(crate::marketplace::install_marketplace_skill(registry_id, skill_id, db))?;

    Ok(json!({ "installed": installed }))
}

