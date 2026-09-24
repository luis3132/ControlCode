//! Los comandos que usa el panel de control de versiones.
//!
//! Todos son `async` y corren git en un hilo aparte: un `git status` en un repo grande
//! tarda, y un comando síncrono de Tauri lo haría esperando en el hilo de la ventana.

use std::path::Path;

use serde::Serialize;

use super::git::{network, repo_root, run, run_text, ScmError, COMMIT, LOCAL};
use super::parse::{parse_branches, parse_log, parse_status_v2, Branch, Commit, StatusInfo, BRANCH_FORMAT, LOG_FORMAT};
use super::remote::{parse_remotes, Remote};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmStatus {
    pub root: String,
    #[serde(flatten)]
    pub info: StatusInfo,
    pub remotes: Vec<Remote>,
    /// Una operación a medias que cambia lo que se puede hacer: `merge`, `rebase`,
    /// `cherryPick` o `revert`.
    pub operation: Option<String>,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ScmError> + Send + 'static,
) -> Result<T, ScmError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| ScmError::Git(e.to_string()))?
}

/// Las rutas llegan relativas al root. `--` antes de ellas para que una llamada `-f` no
/// se lea como opción.
fn with_paths<'a>(args: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut all = args.to_vec();
    all.push("--");
    all.extend(paths.iter().map(String::as_str));
    all
}

fn operation_in_progress(root: &str) -> Option<String> {
    let dir = run_text(root, &["rev-parse", "--absolute-git-dir"], LOCAL).ok()?;
    let dir = Path::new(dir.trim());
    let op = if dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        "rebase"
    } else if dir.join("CHERRY_PICK_HEAD").exists() {
        "cherryPick"
    } else if dir.join("REVERT_HEAD").exists() {
        "revert"
    } else {
        return None;
    };
    Some(op.to_string())
}

/// El estado del repo que contiene `cwd`. `None` si no hay repo: no es un error, el panel
/// ofrece inicializarlo.
#[tauri::command]
pub async fn scm_status(cwd: String) -> Result<Option<ScmStatus>, ScmError> {
    blocking(move || {
        let Some(root) = repo_root(&cwd) else { return Ok(None) };
        let raw = run_text(
            &root,
            &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
            LOCAL,
        )?;
        let remotes = run_text(&root, &["remote", "-v"], LOCAL)
            .map(|r| parse_remotes(&r))
            .unwrap_or_default();
        Ok(Some(ScmStatus {
            operation: operation_in_progress(&root),
            info: parse_status_v2(&raw),
            remotes,
            root,
        }))
    })
    .await
}

#[tauri::command]
pub async fn scm_init(cwd: String) -> Result<(), ScmError> {
    blocking(move || run(&cwd, &["init"], LOCAL).map(|_| ())).await
}

/// Prepara las rutas dadas, o todo si no se da ninguna. `-A` para que un archivo borrado
/// también quede preparado como borrado.
#[tauri::command]
pub async fn scm_stage(root: String, paths: Vec<String>) -> Result<(), ScmError> {
    blocking(move || {
        let args = if paths.is_empty() { vec!["add", "-A"] } else { with_paths(&["add", "-A"], &paths) };
        run(&root, &args, LOCAL).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn scm_unstage(root: String, paths: Vec<String>) -> Result<(), ScmError> {
    blocking(move || {
        let all = vec![".".to_string()];
        let targets = if paths.is_empty() { &all } else { &paths };
        // Sin ningún commit no hay HEAD al que volver: `restore --staged` falla, y lo que
        // corresponde es sacar los archivos del índice.
        let initial = run(&root, &["rev-parse", "--verify", "-q", "HEAD"], LOCAL).is_err();
        let args = if initial {
            with_paths(&["rm", "--cached", "-r", "-q"], targets)
        } else {
            with_paths(&["restore", "--staged"], targets)
        };
        run(&root, &args, LOCAL).map(|_| ())
    })
    .await
}

/// Descarta cambios. Irreversible: la UI pide confirmación antes de llamarlo.
///
/// Los archivos con seguimiento vuelven a como están en el índice (lo preparado no se
/// toca); los que no tienen seguimiento se borran.
#[tauri::command]
pub async fn scm_discard(root: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), ScmError> {
    blocking(move || {
        if !tracked.is_empty() {
            run(&root, &with_paths(&["restore", "--worktree"], &tracked), LOCAL)?;
        }
        if !untracked.is_empty() {
            run(&root, &with_paths(&["clean", "-f", "-q"], &untracked), LOCAL)?;
        }
        Ok(())
    })
    .await
}

/// `stage_all`: preparar todo antes, para el caso de commitear sin haber preparado nada
/// — lo que VS Code llama "smart commit" y lo que casi todo el mundo quiere.
#[tauri::command]
pub async fn scm_commit(root: String, message: String, stage_all: bool) -> Result<(), ScmError> {
    blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err(ScmError::Git("El mensaje del commit está vacío".to_string()));
        }
        if stage_all {
            run(&root, &["add", "-A"], LOCAL)?;
        }
        run(&root, &["commit", "-m", message], COMMIT).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn scm_branches(root: String) -> Result<Vec<Branch>, ScmError> {
    blocking(move || {
        let format = format!("--format={BRANCH_FORMAT}");
        let raw = run_text(&root, &["for-each-ref", &format, "refs/heads", "refs/remotes"], LOCAL)?;
        Ok(parse_branches(&raw))
    })
    .await
}

/// Cambiar de rama. Con `create`, la crea desde donde se está. Una rama remota
/// (`origin/feat`) se trae como local con seguimiento, o se usa la local si ya existe.
#[tauri::command]
pub async fn scm_checkout(root: String, name: String, create: bool, remote: bool) -> Result<(), ScmError> {
    blocking(move || {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(ScmError::Git("Falta el nombre de la rama".to_string()));
        }
        // `git switch -x` es una opción, no una rama. Git no deja crear ramas así, pero el
        // nombre llega de un campo de texto y no puede terminar como argumento de otra cosa.
        if name.starts_with('-') {
            return Err(ScmError::Git(format!("«{name}» no es un nombre de rama válido")));
        }
        if create {
            run(&root, &["check-ref-format", "--branch", &name], LOCAL)
                .map_err(|_| ScmError::Git(format!("«{name}» no es un nombre de rama válido")))?;
            return run(&root, &["switch", "-c", &name], LOCAL).map(|_| ());
        }
        if remote {
            let local = name.split_once('/').map(|(_, rest)| rest).unwrap_or(&name).to_string();
            let exists = run(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{local}")], LOCAL).is_ok();
            return if exists {
                run(&root, &["switch", &local], LOCAL).map(|_| ())
            } else {
                run(&root, &["switch", "--track", &name], LOCAL).map(|_| ())
            };
        }
        run(&root, &["switch", &name], LOCAL).map(|_| ())
    })
    .await
}

/// Las tres operaciones de red. Viven en una sola función porque además de los botones
/// del panel las usa el MCP (`git_fetch`/`git_pull`/`git_push`): un agente sube con la
/// cuenta de la app por el mismo camino que un click.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Sync {
    Fetch,
    Pull,
    Push,
}

pub(crate) async fn sync(app: &tauri::AppHandle, root: String, op: Sync) -> Result<String, ScmError> {
    let env = crate::forge::git_env(app, &root).await;
    blocking(move || match op {
        Sync::Fetch => network(&root, &["fetch", "--all", "--prune"], &env).map(|_| "Fetched.".to_string()),
        // `--no-edit`: si el pull termina en un merge, git abriría un editor para el
        // mensaje, y acá no hay editor que abrir.
        Sync::Pull => network(&root, &["pull", "--no-edit"], &env),
        Sync::Push => push(&root, &env),
    })
    .await
}

/// Push de la rama actual. Si todavía no tiene upstream la publica en `origin` (o en el
/// único remoto que haya), que es lo que se quiere la primera vez.
pub(super) fn push(root: &str, env: &[(String, String)]) -> Result<String, ScmError> {
    let raw = run_text(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], LOCAL)?;
    let info = parse_status_v2(&raw);
    let Some(branch) = info.branch else {
        return Err(ScmError::Git("No hay una rama activa (HEAD desprendido)".to_string()));
    };
    if info.upstream.is_some() {
        network(root, &["push"], env)?;
        return Ok(format!("Pushed {branch}."));
    }
    let remotes = parse_remotes(&run_text(root, &["remote", "-v"], LOCAL)?);
    let remote = remotes
        .iter()
        .find(|r| r.name == "origin")
        .or_else(|| remotes.first())
        .ok_or_else(|| ScmError::Git("El repo no tiene ningún remoto al que subir".to_string()))?;
    network(root, &["push", "-u", &remote.name, &branch], env)?;
    Ok(format!("Published {branch} to {}.", remote.name))
}

#[tauri::command]
pub async fn scm_fetch(app: tauri::AppHandle, root: String) -> Result<(), ScmError> {
    sync(&app, root, Sync::Fetch).await.map(|_| ())
}

#[tauri::command]
pub async fn scm_pull(app: tauri::AppHandle, root: String) -> Result<(), ScmError> {
    sync(&app, root, Sync::Pull).await.map(|_| ())
}

#[tauri::command]
pub async fn scm_push(app: tauri::AppHandle, root: String) -> Result<(), ScmError> {
    sync(&app, root, Sync::Push).await.map(|_| ())
}

#[tauri::command]
pub async fn scm_log(root: String, limit: u32) -> Result<Vec<Commit>, ScmError> {
    blocking(move || {
        let n = format!("-n{}", limit.clamp(1, 200));
        let format = format!("--format={LOG_FORMAT}");
        // Un repo sin commits hace fallar a `git log`: no es un error, es una lista vacía.
        Ok(run_text(&root, &["log", &n, &format], LOCAL).map(|raw| parse_log(&raw)).unwrap_or_default())
    })
    .await
}

/// El contenido de un archivo en `HEAD` o en el índice (`rev = "INDEX"`), para el diff.
/// `None` si no existe ahí: un archivo nuevo no está en HEAD.
#[tauri::command]
pub async fn scm_file_at(root: String, path: String, rev: String) -> Result<Option<String>, ScmError> {
    blocking(move || {
        let spec = if rev == "INDEX" { format!(":{path}") } else { format!("HEAD:{path}") };
        let Ok(bytes) = run(&root, &["show", &spec], LOCAL) else { return Ok(None) };
        if bytes.contains(&0) {
            return Err(ScmError::Git("Es un archivo binario".to_string()));
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    })
    .await
}
