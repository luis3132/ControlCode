//! Comandos de skills: las instaladas, el marketplace y la instalación.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::shared::db;
use crate::ipc::protocol::{arg_str, arg_str_opt};

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

    // Se busca por nombre o id entre lo que ofrecen los repos habilitados. Un nombre que
    // corresponde a VARIAS entradas es un error, no una elección por prioridad: dos skills
    // homónimas pueden ser de autores distintos y hacer cosas distintas, así que instalar
    // "la del repo mejor rankeado" le deja al usuario una skill que no pidió.
    let find = || -> Result<Option<crate::marketplace::MarketplaceSkillEntry>, String> {
        let all = crate::marketplace::list_marketplace_skills(None, None, db.clone())?;
        if let Some(exacta) = all.iter().find(|e| e.id.to_lowercase() == wanted) {
            return Ok(Some(exacta.clone()));
        }
        let por_nombre: Vec<_> = all.iter().filter(|e| e.name.to_lowercase() == wanted).collect();
        match por_nombre.as_slice() {
            [] => Ok(None),
            [una] => Ok(Some((*una).clone())),
            varias => {
                let detalle: Vec<String> = varias
                    .iter()
                    .map(|e| match &e.author {
                        Some(a) => format!("{} ({a}, {})", e.id, e.registry_name),
                        None => format!("{} ({})", e.id, e.registry_name),
                    })
                    .collect();
                Err(format!(
                    "Hay {} skills llamadas '{skill}' y no son la misma. Instalá por id: {}",
                    varias.len(),
                    detalle.join(" · ")
                ))
            }
        }
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


/// El SKILL.md de una skill instalada, para poder leerla desde la terminal.
///
/// Es la primera mitad del ciclo leer → editar → guardar: sin esto, `skill edit` obligaría
/// a adivinar el contenido o a ir a buscarlo al disco por afuera de la app.
pub(super) fn skill_show(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let wanted = arg_str(args, "skill")?;
    let db = db(app)?;
    let skill = resolve_installed(&db, &wanted)?;
    let detail = crate::skills::get_skill_detail(skill.id.clone(), db)?;

    Ok(json!({
        "id": detail.skill.id,
        "name": detail.skill.name,
        "description": detail.skill.description,
        "version": detail.skill.version,
        "author": detail.skill.author,
        // De dónde salió: `null` = local, o sea editable en el lugar. Lo que venga de un
        // repositorio se edita creando una copia (ver `skill_edit`).
        "registry": detail.skill.registry_name,
        "content": detail.content,
    }))
}

/// Crea una skill propia, de origen local.
pub(super) fn skill_new(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let name = arg_str(args, "name")?;
    let db = db(app)?;

    let draft = crate::skills::SkillDraft {
        meta: crate::skills::SkillFrontmatterInput {
            name: Some(name),
            description: arg_str_opt(args, "description"),
            version: arg_str_opt(args, "version"),
            categories: list_arg(args, "categories"),
            compatible_agents: list_arg(args, "agents"),
            compatible_versions: Default::default(),
            author: arg_str_opt(args, "author"),
            license: arg_str_opt(args, "license"),
            homepage: arg_str_opt(args, "homepage"),
        },
        body: arg_str_opt(args, "content").unwrap_or_default(),
    };

    let created = crate::skills::create_skill(draft, db)?;
    Ok(json!({ "created": { "id": created.id, "name": created.name } }))
}

/// Guarda contenido nuevo en una skill instalada.
///
/// Si la skill vino de un repositorio, esto NO la pisa: crea una copia de origen local con
/// los cambios y deja la original intacta para que siga recibiendo actualizaciones (ver
/// `skills::authoring`). Con `--copy` se fuerza ese mismo comportamiento para una skill
/// que ya es local, que es la forma de partir de la propia sin perderla.
pub(super) fn skill_edit(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let wanted = arg_str(args, "skill")?;
    let db = db(app)?;
    let skill = resolve_installed(&db, &wanted)?;

    let content = arg_str_opt(args, "content");
    let new_name = arg_str_opt(args, "name");
    if content.is_none() && new_name.is_none() {
        return Err("Nada que guardar: pasá --content, --file o --name".to_string());
    }

    let is_local = skill.registry_name.is_none();
    let force_copy = args.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);

    if is_local && !force_copy {
        // Es del usuario: se guarda encima, como cualquier archivo propio.
        let current = crate::skills::get_skill_detail(skill.id.clone(), db.clone())?.content;
        let content = content.unwrap_or(current);
        let content = match &new_name {
            Some(n) => crate::skills::rename_in_content(&content, n),
            None => content,
        };
        crate::skills::update_skill_content(skill.id.clone(), content, db)?;
        return Ok(json!({ "saved": { "id": skill.id, "name": new_name.unwrap_or(skill.name), "copied": false } }));
    }

    let copy = crate::skills::fork_skill(skill.id, new_name, content, db)?;
    Ok(json!({
        "saved": { "id": copy.id, "name": copy.name, "copied": true },
        // Se dice explícitamente por qué hay una skill nueva: quien automatiza tiene que
        // poder distinguir "guardé" de "creé otra".
        "note": "La original vino de un repositorio y no se toca; los cambios quedaron en una copia local",
    }))
}

/// Resuelve un nombre o id a UNA skill instalada. Un nombre ambiguo es un error, no una
/// elección al azar — ver `match_one_skill`.
fn resolve_installed(
    db: &tauri::State<'_, crate::database::DbConnection>,
    wanted: &str,
) -> Result<crate::skills::SkillInfo, String> {
    let rows = crate::skills::list_skills((*db).clone())?;
    let installed: Vec<super::tabs::InstalledSkill> = rows
        .iter()
        .map(|s| super::tabs::InstalledSkill {
            id: s.skill.id.clone(),
            name: s.skill.name.clone(),
            author: s.skill.author.clone(),
            registry_name: s.skill.registry_name.clone(),
        })
        .collect();
    let id = super::tabs::match_skill_ids(&installed, std::slice::from_ref(&wanted.to_string()))?
        .into_iter()
        .next()
        .ok_or_else(|| format!("No se encontró la skill '{wanted}'"))?;

    rows.into_iter()
        .map(|s| s.skill)
        .find(|s| s.id == id)
        .ok_or_else(|| format!("No se encontró la skill '{wanted}'"))
}

/// `--categories a,b` / `--agents a,b` llegan como array (los parte la CLI).
fn list_arg(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}
