//! Agentes headless: los que corren sin terminal y sin que nadie los mire.
//!
//! Un agente de una tab es un PTY que el usuario mira y tipea. Uno de acá es un proceso
//! con el stdout redirigido del que la app es dueña de punta a punta: emite eventos
//! estructurados en vez de pixeles, así que qué archivo tocó, cuánto costó y si terminó
//! bien vienen **como datos** y no hay que inferirlos de una pantalla redibujada.
//!
//! Eso es lo que hace posible la consola de flota: ver de un vistazo qué está haciendo
//! cada agente. La capa de `orchestrator::{digest,cursors,watch}` sigue siendo para las
//! tabs interactivas y no se toca — acá no hace falta comprimir nada.

mod activity;
mod agents;
mod broker;
mod context;
pub mod orchestration;
mod plan;
mod quota;
mod roster;
mod routing;
mod rules;
mod scheduler;
mod store;
mod supervisor;
mod types;
mod worktrees;
#[cfg(test)]
mod test;

pub use store::sweep_orphans;
pub use types::{Fact, Run, Task};

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

fn db_of(app: &AppHandle) -> Result<DbConnection, String> {
    Ok(app
        .try_state::<DbConnection>()
        .ok_or_else(|| "la base no está disponible".to_string())?
        .inner()
        .clone())
}

/// Las tarjetas de un workspace, más recientes primero.
#[tauri::command]
pub fn run_list_tasks(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_tasks(&conn, &workspace_id)
}

#[tauri::command]
pub fn run_list_runs(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<Run>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_runs(&conn, &workspace_id)
}

/// Asigna la tarea, la crea y la lanza.
///
/// Por ahora cada lanzamiento abre su propio run. Cuando entre el DAG, un run pasará a
/// agrupar varias tareas con sus dependencias; la forma ya está para eso.
///
/// El modelo y la cuenta salen del ruteo (`routing::route`): o se nombran, o se declara la
/// complejidad y elige la app. Si no hay a quién asignarla, vuelve el motivo y NO se crea
/// la fila: no se lanzó nada, y lo que hay que hacer es cambiar el pedido, no diagnosticar
/// una tarjeta fallida.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_start_task(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    title: String,
    prompt: String,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    // Que la cuenta la elija el ruteo. Con `false`, `account_id` manda (y `None` es la del
    // sistema).
    auto_account: bool,
    budget_usd: Option<f64>,
    // En su propio worktree. Es lo que hace seguro lanzar un segundo agente sobre una
    // carpeta en la que ya trabaja otro.
    isolate: bool,
) -> Result<Task, String> {
    let db = db_of(&app)?;
    let request = route_request(agent_id, model, complexity, account_id, auto_account);
    let assignment = assign(&db, request).await?;
    let note = (!assignment.notes.is_empty()).then(|| assignment.notes.join("\n"));

    let mut task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let run = store::create_run(&conn, &workspace_id, &title, &cwd)?;
        store::create_task(
            &conn,
            &store::NewTask {
                run_id: &run.id,
                title: &title,
                prompt: &prompt,
                agent_id: &assignment.agent_id,
                account_id: assignment.account_id.as_deref(),
                model: assignment.model.as_deref(),
                cwd: &cwd,
                budget_usd,
                complexity: complexity.map(routing::Complexity::as_str),
                routed_by: Some(assignment.routed_by.as_str()),
                route_note: note.as_deref(),
                ..Default::default()
            },
        )?
    };

    // Si el lanzamiento falla, la fila queda igual pero como fallida: una tarea que
    // desaparece sin dejar rastro no se puede diagnosticar, y el motivo (un binario que
    // no está, una cuenta borrada, una carpeta que no es un repo) es justo lo que hay que
    // mostrar.
    let fail = |task_id: &str, e: String| -> Result<Task, String> {
        let conn = db.lock().map_err(|err| err.to_string())?;
        store::finish_task(&conn, task_id, &types::TaskOutcome::failed(e.clone()))?;
        Err(e)
    };

    if isolate {
        match worktrees_base().and_then(|base| isolate_task(&base, &db, &task)) {
            Ok(isolated) => task = isolated,
            Err(e) => return fail(&task.id, e),
        }
    }

    if let Err(e) = supervisor::start(&app, task.clone(), supervisor::LaunchExtras::default()) {
        return fail(&task.id, e);
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al lanzarla".into())
}

/// Lanza un lead: el agente que va a repartir `objective` en tareas para otros agentes.
///
/// El run nace con el paralelismo y el presupuesto que se piden acá; el plan lo declara el
/// lead cuando entiende el proyecto. Sin modelo ni complejidad, el lead va a `hard`: de
/// cómo reparte depende lo que cuesta todo lo demás.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_start_orchestration(
    app: AppHandle,
    workspace_id: String,
    cwd: String,
    objective: String,
    max_parallel: i64,
    budget_usd: Option<f64>,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> Result<Task, String> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return Err("falta el objetivo".into());
    }
    let db = db_of(&app)?;
    let complexity = complexity.or((agent_id.is_none() && model.is_none()).then_some(routing::Complexity::Hard));
    let assignment = assign(&db, route_request(agent_id, model, complexity, account_id, auto_account)).await?;
    let note = (!assignment.notes.is_empty()).then(|| assignment.notes.join("\n"));
    let max_parallel = max_parallel.clamp(1, 6);

    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let run = store::create_run_with(&conn, &workspace_id, &objective, &cwd, max_parallel, budget_usd)?;
        let title: String = objective.lines().next().unwrap_or("").chars().take(80).collect();
        let budget = budget_usd.map(|b| format!(" El run tiene un presupuesto de ${b:.2}: ninguna tarea nueva arranca después de gastarlo."))
            .unwrap_or_default();
        let prompt = format!("{objective}\n\n(Hasta {max_parallel} tareas en paralelo.{budget})");
        store::create_task(
            &conn,
            &store::NewTask {
                run_id: &run.id,
                title: &title,
                prompt: &prompt,
                agent_id: &assignment.agent_id,
                account_id: assignment.account_id.as_deref(),
                model: assignment.model.as_deref(),
                cwd: &cwd,
                complexity: complexity.map(routing::Complexity::as_str),
                routed_by: Some(assignment.routed_by.as_str()),
                route_note: note.as_deref(),
                role: Some(types::role::LEAD),
                ..Default::default()
            },
        )?
    };

    use crate::ipc::mcp::{orchestration_tool_names, OrchestrationPower::*};
    let extras = supervisor::LaunchExtras {
        prompt: None,
        system_prompt: Some(context::LEAD_SYSTEM_PROMPT.to_string()),
        allowed_tools: orchestration_tool_names(&[Read, Note, Spawn]),
    };
    if let Err(e) = supervisor::start(&app, task.clone(), extras) {
        let conn = db.lock().map_err(|err| err.to_string())?;
        store::finish_task(&conn, &task.id, &types::TaskOutcome::failed(e.clone()))?;
        let _ = store::refresh_run_status(&conn, &task.run_id);
        return Err(e);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al lanzarla".into())
}

/// Lanza una tarea de un plan que le tocó correr: su worktree si va aislada, y su prompt con
/// lo que entregaron sus dependencias y los hechos del run. `false` si no se pudo — la fila
/// ya queda cerrada como fallida, y quien despacha tiene que volver a mirar el run.
pub(crate) fn launch_planned(app: &AppHandle, db: &DbConnection, task: Task) -> bool {
    let task_id = task.id.clone();
    let launched = (|| -> Result<(), String> {
        let (run, deps, facts) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let run = store::run_by_id(&conn, &task.run_id)?.ok_or("el run ya no existe")?;
            let mut deps = Vec::new();
            for id in &task.depends_on {
                if let Some(dep) = store::task_by_id(&conn, id)? {
                    deps.push(dep);
                }
            }
            let facts = store::facts_of_run(&conn, &run.id)?;
            (run, deps, facts)
        };

        // De qué rama parte: la de su única dependencia aislada, para empezar desde lo que
        // esa dejó. Con varias, desde HEAD, y el prompt le pide integrarlas primero.
        let dep_branches: Vec<String> = deps
            .iter()
            .filter(|d| !d.worktree_removed)
            .filter_map(|d| d.branch.clone())
            .collect();
        let mut task = task.clone();
        if task.isolate {
            let start = if dep_branches.len() == 1 { dep_branches[0].as_str() } else { "HEAD" };
            task = isolate_task_from(&worktrees_base()?, db, &task, start)?;
        }
        let to_merge: &[String] = if task.isolate && dep_branches.len() > 1 { &dep_branches } else { &[] };

        let deps_refs: Vec<&Task> = deps.iter().collect();
        let prompt = context::worker_prompt(&task, &run.objective, &deps_refs, &facts, to_merge);
        let can_delegate = task.depth < plan::MAX_DEPTH;
        use crate::ipc::mcp::{orchestration_tool_name, orchestration_tool_names, OrchestrationPower::*};
        let mut allowed = orchestration_tool_names(&[Read, Note]);
        if can_delegate {
            allowed.push(orchestration_tool_name("task_add"));
        }
        supervisor::start(
            app,
            task.clone(),
            supervisor::LaunchExtras {
                prompt: Some(prompt),
                system_prompt: Some(context::worker_system_prompt(&task, can_delegate)),
                allowed_tools: allowed,
            },
        )
    })();

    match launched {
        Ok(()) => true,
        Err(e) => {
            if let Ok(conn) = db.lock() {
                let _ = store::finish_task(&conn, &task_id, &types::TaskOutcome::failed(e));
            }
            supervisor::notify_changed(app, &task_id);
            false
        }
    }
}

/// Para un run entero: lo que espera no arranca y lo que corre se detiene.
#[tauri::command]
pub fn run_cancel_run(app: AppHandle, run_id: String) -> Result<(), String> {
    let db = db_of(&app)?;
    let live: Vec<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::cancel_pending(&conn, &run_id, "se canceló el run")?;
        store::tasks_of_run(&conn, &run_id)?
            .into_iter()
            .filter(|t| matches!(t.status.as_str(), types::status::READY | types::status::RUNNING))
            .map(|t| t.id)
            .collect()
    };
    for id in &live {
        supervisor::cancel(&app, id)?;
    }
    let ids: Vec<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::refresh_run_status(&conn, &run_id)?;
        store::tasks_of_run(&conn, &run_id)?.into_iter().map(|t| t.id).collect()
    };
    scheduler::bump(&run_id);
    for id in &ids {
        supervisor::notify_changed(&app, id);
    }
    Ok(())
}

/// Lo que se dejaron escrito los agentes de un run.
#[tauri::command]
pub fn run_list_facts(run_id: String, db: tauri::State<DbConnection>) -> Result<Vec<Fact>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::facts_of_run(&conn, &run_id)
}

fn route_request(
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> routing::RouteRequest {
    routing::RouteRequest {
        agent_id,
        // Un modelo en blanco es "el de siempre", no un modelo llamado "".
        model: model.filter(|m| !m.trim().is_empty()),
        complexity,
        account: if auto_account {
            routing::AccountChoice::Auto
        } else {
            routing::AccountChoice::Fixed(account_id)
        },
    }
}

/// Corre el ruteo fuera del hilo async: la primera vez sondea el roster, que lanza procesos.
async fn assign(db: &DbConnection, request: routing::RouteRequest) -> Result<routing::Assignment, String> {
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let roster = roster::snapshot(&db, false)?;
        let tiers = routing::load_tiers(&db);
        routing::route(&roster, &tiers, &request, crate::util::now_ts())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Qué agentes, modelos y cuentas hay para lanzar ahora. `refresh` vuelve a sondear las
/// TUIs aunque lo último sea reciente.
#[tauri::command]
pub async fn run_roster(app: AppHandle, refresh: bool) -> Result<roster::Roster, String> {
    let db = db_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || roster::snapshot(&db, refresh))
        .await
        .map_err(|e| e.to_string())?
}

/// A quién le tocaría una tarea con estos datos, sin lanzarla. Es lo que muestra el
/// diálogo antes de apretar "Lanzar": enterarse de que fue a otra cuenta DESPUÉS sería
/// enterarse tarde.
#[tauri::command]
pub async fn run_preview_route(
    app: AppHandle,
    agent_id: Option<String>,
    model: Option<String>,
    complexity: Option<routing::Complexity>,
    account_id: Option<String>,
    auto_account: bool,
) -> Result<routing::Assignment, String> {
    let db = db_of(&app)?;
    assign(&db, route_request(agent_id, model, complexity, account_id, auto_account)).await
}

#[tauri::command]
pub fn run_get_tiers(db: tauri::State<DbConnection>) -> routing::Tiers {
    routing::load_tiers(&db)
}

#[tauri::command]
pub fn run_set_tiers(tiers: routing::Tiers, db: tauri::State<DbConnection>) -> Result<routing::Tiers, String> {
    for c in [routing::Complexity::Trivial, routing::Complexity::Standard, routing::Complexity::Hard] {
        let entries = tiers.get(c);
        // Un tramo vacío no tiene a quién asignar: lanzar con esa complejidad fallaría
        // siempre, y se enteraría quien lanza en vez de quien lo dejó vacío.
        if entries.is_empty() {
            return Err(format!("el tramo {} necesita al menos un modelo", c.as_str()));
        }
        if let Some(bad) = entries.iter().find(|e| crate::agents::agent_def(&e.agent_id).is_none()) {
            return Err(format!("'{}' no es un agente conocido", bad.agent_id));
        }
        if entries.iter().any(|e| e.model.trim().is_empty()) {
            return Err(format!("el tramo {} tiene un modelo sin nombre", c.as_str()));
        }
    }
    routing::save_tiers(&db, &tiers)?;
    Ok(tiers)
}

/// Dónde viven los worktrees de las tareas. Fuera del repo a propósito: adentro habría que
/// ignorarlos en `.gitignore`, y cualquier herramienta que recorra el proyecto (un linter,
/// el mismo agente) los encontraría como si fueran parte del código.
fn worktrees_base() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "no se pudo resolver el home".to_string())?
        .join(".controlcode")
        .join("worktrees"))
}

/// Crea el worktree de una tarea, le monta las skills del proyecto y deja la fila
/// apuntando adentro. `base` se recibe para que los tests no escriban en el home.
pub(crate) fn isolate_task(base: &std::path::Path, db: &DbConnection, task: &Task) -> Result<Task, String> {
    isolate_task_from(base, db, task, "HEAD")
}

pub(crate) fn isolate_task_from(base: &std::path::Path, db: &DbConnection, task: &Task, start: &str) -> Result<Task, String> {
    let project = std::path::Path::new(&task.cwd);
    let wt = worktrees::create_from(base, project, &task.title, start)?;

    let conn = db.lock().map_err(|e| e.to_string())?;
    // Las skills que el usuario ve en el proyecto, también adentro. Best-effort: sin la
    // carpeta global configurada, o sin skills, el agente arranca igual.
    if let (Ok(skills_dir), Some(project_links), Some(task_links)) = (
        crate::skills::skills_dir_from_conn(&conn),
        crate::skills::links_dir_for(&task.cwd, &task.agent_id),
        crate::skills::links_dir_for(&wt.task_cwd.to_string_lossy(), &task.agent_id),
    ) {
        worktrees::link_skills(&project_links, &task_links, &skills_dir);
    }

    store::set_worktree(
        &conn,
        &task.id,
        &wt.task_cwd.to_string_lossy(),
        &wt.root.to_string_lossy(),
        &wt.branch,
    )?;
    store::task_by_id(&conn, &task.id)?.ok_or_else(|| "la tarea se perdió al aislarla".into())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardedWorktree {
    pub branch: String,
    /// La rama quedó porque tiene commits que no están en ningún otro lado.
    pub branch_kept: bool,
}

/// Descarta el worktree de una tarea terminada.
///
/// Nunca con la tarea viva: sería sacarle la carpeta a un agente que está trabajando.
/// Se niega también si hay cambios sin commitear (ver `worktrees::remove`).
#[tauri::command]
pub fn run_discard_worktree(app: AppHandle, task_id: String) -> Result<DiscardedWorktree, String> {
    let db = db_of(&app)?;
    let (task, project_cwd, skills_dir) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let task = store::task_by_id(&conn, &task_id)?.ok_or_else(|| "la tarea ya no existe".to_string())?;
        let project = store::project_cwd_of_task(&conn, &task_id).ok_or("la tarea no tiene run")?;
        (task, project, crate::skills::skills_dir_from_conn(&conn)?)
    };

    if matches!(task.status.as_str(), types::status::READY | types::status::RUNNING) {
        return Err("la tarea todavía está corriendo: parala o esperá a que termine".into());
    }
    let (Some(root), Some(branch)) = (task.worktree_path.clone(), task.branch.clone()) else {
        return Err("esta tarea no corre en un worktree".into());
    };
    if task.worktree_removed {
        return Err("el worktree de esta tarea ya se descartó".into());
    }

    let wt = worktrees::Worktree {
        root: root.into(),
        task_cwd: task.cwd.clone().into(),
        branch: branch.clone(),
    };
    let links = crate::skills::links_dir_for(&task.cwd, &task.agent_id).unwrap_or_default();
    // Cualquier carpeta del repo sirve para `git -C`; la del proyecto sigue existiendo.
    let removed = worktrees::remove(std::path::Path::new(&project_cwd), &wt, &links, &skills_dir)?;

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::mark_worktree_removed(&conn, &task_id)?;
    }
    supervisor::notify_changed(&app, &task_id);
    Ok(DiscardedWorktree { branch, branch_kept: removed.branch_kept })
}

#[tauri::command]
pub fn run_cancel_task(app: AppHandle, task_id: String) -> Result<(), String> {
    supervisor::cancel(&app, &task_id)
}

/// Deja la tarea lista para seguirla en una terminal y devuelve la fila con lo necesario
/// para abrirla: la sesión, la cuenta y la carpeta.
///
/// Si todavía corre, la para (ver `supervisor::hand_off`). Si ya terminó, no toca nada:
/// reabrir una conversación cerrada es solo reanudarla.
#[tauri::command]
pub fn run_hand_off_task(app: AppHandle, task_id: String) -> Result<Task, String> {
    let db = db_of(&app)?;
    let task = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::task_by_id(&conn, &task_id)?.ok_or_else(|| "la tarea ya no existe".to_string())?
    };

    // Sin sesión no hay nada que reanudar: la tarea falló antes de que la TUI arrancara.
    // Abrir una tab igual daría una conversación NUEVA presentada como la de la tarea.
    if task.session_id.is_none() {
        return Err("esta tarea nunca llegó a arrancar: no hay conversación para seguir".into());
    }
    // La sesión quedó atada a la ruta del worktree: sin la carpeta, `--resume` en otro
    // lado no la encuentra y abriría una conversación nueva haciéndose pasar por esta.
    if task.worktree_removed {
        return Err("el worktree de esta tarea se descartó: su conversación ya no tiene dónde retomarse".into());
    }

    if matches!(task.status.as_str(), types::status::READY | types::status::RUNNING) {
        supervisor::hand_off(&app, &task_id)?;
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    store::task_by_id(&conn, &task_id)?.ok_or_else(|| "la tarea ya no existe".into())
}

// ── Permisos ────────────────────────────────────────────────────

/// Lo que el puente MCP de una tarea pregunta: ¿puede usar esta herramienta?
///
/// Vive acá y no en `broker` porque además de resolverlo hay que avisarle a la consola: un
/// pedido que espera y nadie ve es un agente parado en silencio.
pub fn resolve_permission(
    app: &AppHandle,
    db: &DbConnection,
    task_id: &str,
    tool_name: &str,
    input: serde_json::Value,
    timeout: Duration,
) -> broker::Verdict {
    supervisor::notify_approvals(app);
    let verdict = broker::resolve(db, task_id, tool_name, input, timeout);
    // Y otra vez al cerrarse, para que la tarjeta deje de pedir.
    supervisor::notify_approvals(app);
    verdict
}

/// Los pedidos que están esperando a una persona ahora mismo.
#[tauri::command]
pub fn run_pending_approvals() -> Vec<broker::PendingApproval> {
    broker::pending()
}

/// Contesta un pedido. `false` si ya no existe: venció, o la tarea se canceló mientras
/// tanto, y en los dos casos el usuario tiene que enterarse en vez de creer que decidió.
///
/// Con `remember`, además deja escrita la regla exacta del pedido para su carpeta, y
/// resuelve con ella lo que otros agentes de esa carpeta estuvieran esperando.
#[tauri::command]
pub fn run_decide_approval(
    app: AppHandle,
    approval_id: String,
    allow: bool,
    remember: bool,
    db: tauri::State<DbConnection>,
) -> Result<bool, String> {
    let Some(pending) = broker::get(&approval_id) else {
        supervisor::notify_approvals(&app);
        return Ok(false);
    };

    // La regla se guarda ANTES de contestar: si guardarla falla, el usuario tiene que
    // enterarse ahí, no después de que el agente ya siguió creyendo que quedó recordado.
    let remembered_in = if remember {
        remember_rule(&db, &pending, allow)?
    } else {
        None
    };

    let decided = broker::decide(&approval_id, allow, None);
    if let Some(cwd) = remembered_in {
        broker::release_matching(&db, &cwd);
    }
    supervisor::notify_approvals(&app);
    Ok(decided)
}

/// Guarda la regla exacta de un pedido. Devuelve la carpeta en la que quedó.
fn remember_rule(
    db: &DbConnection,
    pending: &broker::PendingApproval,
    allow: bool,
) -> Result<Option<String>, String> {
    // Un pedido sin regla exacta posible no ofrece "recordar" en la consola; si igual llega
    // acá (un click contra una tarjeta vieja), se contesta sin recordar en vez de inventar
    // una regla más amplia que lo que se vio.
    let Some(pattern) = rules::exact_rule_for(&pending.tool_name, &pending.input) else {
        return Ok(None);
    };
    let conn = db.lock().map_err(|e| e.to_string())?;
    let Some(cwd) = store::project_cwd_of_task(&conn, &pending.task_id) else {
        return Ok(None);
    };
    store::upsert_rule(&conn, &cwd, &pattern, allow)?;
    Ok(Some(cwd))
}

/// Las reglas de una carpeta, en el orden en que se evalúan.
#[tauri::command]
pub fn run_list_rules(cwd: String, db: tauri::State<DbConnection>) -> Result<Vec<store::RuleRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::list_rules(&conn, &cwd)
}

/// Agrega una regla escrita a mano, y resuelve con ella lo que estuviera esperando.
#[tauri::command]
pub fn run_add_rule(
    app: AppHandle,
    cwd: String,
    pattern: String,
    allow: bool,
    db: tauri::State<DbConnection>,
) -> Result<store::RuleRow, String> {
    if !rules::is_valid_pattern(&pattern) {
        return Err(format!(
            "'{pattern}' no tiene la forma de una regla: Herramienta o Herramienta(patrón)"
        ));
    }
    let row = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::upsert_rule(&conn, &cwd, &pattern, allow)?
    };
    if broker::release_matching(&db, &cwd) > 0 {
        supervisor::notify_approvals(&app);
    }
    Ok(row)
}

#[tauri::command]
pub fn run_delete_rule(id: String, db: tauri::State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    store::delete_rule(&conn, &id)
}

/// Cierra los pedidos que quedaron colgados de una ejecución anterior de la app.
pub fn sweep_orphan_approvals(db: &DbConnection) -> Result<usize, String> {
    broker::sweep_orphans(db)
}
