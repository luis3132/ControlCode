//! Un worktree de git por tarea: lo que hace seguro correr agentes en paralelo.
//!
//! Dos agentes sobre la misma carpeta editan los mismos archivos a la vez, y el resultado
//! no es "trabajo en paralelo": es uno pisando lo del otro sin que ninguno se entere. Un
//! worktree le da a cada tarea su propia copia de trabajo del repo, en su propia rama,
//! compartiendo el historial. Lo que haga un agente no lo ve el otro hasta que alguien
//! decida juntarlo.
//!
//! ## Lo que conviene saber antes de tocar esto
//!
//! - **Parte del último commit, no de lo que hay en la carpeta.** Lo que el usuario no
//!   commiteó no está en el worktree. La consola lo dice al lanzar.
//! - **La sesión del agente queda atada a la RUTA.** Claude Code guarda el transcript bajo
//!   un nombre derivado de la carpeta. Retomar la tarea en una terminal tiene que abrirla
//!   en el worktree, y descartar el worktree deja esa conversación sin lugar donde
//!   retomarse — por eso descartarlo es un paso explícito y no algo que pasa al terminar.
//! - **Nunca se descarta solo.** Al terminar la tarea, el resultado ESTÁ en el worktree:
//!   borrarlo ahí sería borrar el trabajo que el usuario todavía no revisó.
//! - **Los symlinks de skills son de la app, no del agente.** Git los ve como archivos sin
//!   trackear, así que para él un worktree recién creado ya está "sucio". El chequeo de
//!   cambios los descuenta a ELLOS, uno por uno, y a nada más.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use uuid::Uuid;

use crate::util::output_with_timeout;

/// `worktree add` hace un checkout completo: en un repo grande tarda.
const GIT_SLOW: Duration = Duration::from_secs(120);
const GIT_FAST: Duration = Duration::from_secs(15);

/// Prefijo de las ramas que crea la app. Agrupa las suyas en `git branch` y deja claro de
/// dónde salieron.
pub const BRANCH_PREFIX: &str = "cc/";

#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    /// La raíz del worktree.
    pub root: PathBuf,
    /// Dónde corre la tarea: la misma subcarpeta del repo desde la que se lanzó.
    pub task_cwd: PathBuf,
    pub branch: String,
}

/// Corre git y devuelve stdout, o el error de git tal cual.
///
/// No reusa `explorer::git`, que se traga los errores a propósito (para el explorador, "no
/// es un repo" y "falló" son lo mismo). Acá no: "la rama ya existe" o "el repo no tiene
/// commits" es justo lo que el usuario necesita leer.
fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| format!("no se pudo correr git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} falló", args.join(" ")) } else { err })
    }
}

/// La raíz del repo que contiene `cwd`. Error si no es un repo, o si no tiene commits —
/// sin commit no hay de dónde sacar un worktree.
pub fn repo_root(cwd: &Path) -> Result<PathBuf, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"], GIT_FAST)
        .map_err(|_| "esta carpeta no es un repositorio de git".to_string())?;
    git(cwd, &["rev-parse", "--verify", "HEAD"], GIT_FAST)
        .map_err(|_| "el repositorio todavía no tiene ningún commit".to_string())?;
    Ok(PathBuf::from(root))
}

/// La parte legible del nombre de rama, sacada del título de la tarea.
pub fn branch_slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            other => other,
        };
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 32 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "tarea".into() } else { slug }
}

/// Crea el worktree de una tarea lanzada desde `project_cwd`.
///
/// `base` es la carpeta donde viven los worktrees de la app (`~/.controlcode/worktrees`);
/// se recibe como parámetro para poder probarlo sin tocar el home.
pub fn create(base: &Path, project_cwd: &Path, title: &str) -> Result<Worktree, String> {
    let repo = repo_root(project_cwd)?;
    // Canónicas las dos: en macOS `/tmp` es un symlink a `/private/tmp`, y comparar una
    // ruta resuelta con otra sin resolver haría fallar el `strip_prefix` de abajo.
    let repo = repo.canonicalize().unwrap_or(repo);
    let project = project_cwd.canonicalize().unwrap_or_else(|_| project_cwd.to_path_buf());
    let rel = project.strip_prefix(&repo).unwrap_or(Path::new("")).to_path_buf();

    let short = Uuid::new_v4().simple().to_string()[..8].to_string();
    let branch = format!("{BRANCH_PREFIX}{}-{short}", branch_slug(title));
    let root = base.join(&short);

    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    git(
        &repo,
        &["worktree", "add", "-b", &branch, &root.to_string_lossy(), "HEAD"],
        GIT_SLOW,
    )?;

    let task_cwd = if rel.as_os_str().is_empty() { root.clone() } else { root.join(&rel) };
    Ok(Worktree { root, task_cwd, branch })
}

/// Los symlinks de skills que la app puso en una carpeta: los que apuntan al directorio
/// global de skills. Un symlink del usuario, o una carpeta real, no cuenta.
pub fn managed_links(links_dir: &Path, skills_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(links_dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false)
                && std::fs::read_link(p).map(|t| t.starts_with(skills_dir)).unwrap_or(false)
        })
        .collect()
}

/// Le da al worktree las skills que la carpeta del proyecto tiene montadas.
///
/// Sin esto el agente trabaja sin las skills que el usuario ve en el proyecto: los symlinks
/// son por carpeta, y la del worktree es otra. Se copia el conjunto que YA está montado en
/// el proyecto en vez de recalcularlo, porque eso es exactamente lo que el usuario cree que
/// el agente tiene.
pub fn link_skills(project_links: &Path, task_links: &Path, skills_dir: &Path) -> usize {
    let links = managed_links(project_links, skills_dir);
    if links.is_empty() {
        return 0;
    }
    if std::fs::create_dir_all(task_links).is_err() {
        return 0;
    }
    links
        .iter()
        .filter(|link| {
            let (Some(name), Ok(target)) = (link.file_name(), std::fs::read_link(link)) else {
                return false;
            };
            symlink::symlink_auto(&target, task_links.join(name)).is_ok()
        })
        .count()
}

/// Los archivos con cambios sin commitear, sin contar los symlinks de skills de la app.
///
/// Con `-z` y no con la salida por líneas: una ruta con espacios o acentos sale entre
/// comillas y escapada, y parsearla a mano es la forma segura de terminar comparando mal
/// justo el archivo que importaba.
pub fn dirty_files(root: &Path, managed: &[PathBuf]) -> Result<Vec<String>, String> {
    let out = git(root, &["status", "--porcelain", "-z", "--untracked-files=all"], GIT_FAST)?;
    let mut files = Vec::new();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let (xy, path) = entry.split_at(3);
        // Un renombre trae la ruta vieja en la entrada siguiente: no es otro archivo.
        if xy.starts_with('R') || xy.starts_with('C') {
            entries.next();
        }
        let absolute = root.join(path);
        if !managed.contains(&absolute) {
            files.push(path.to_string());
        }
    }
    Ok(files)
}

/// Lo que pasó al descartar un worktree.
#[derive(Debug, PartialEq)]
pub struct Removed {
    /// La rama se conservó porque tiene commits que no están en ninguna otra: borrarla
    /// sería borrar el trabajo del agente.
    pub branch_kept: bool,
}

/// Descarta el worktree de una tarea.
///
/// Se niega si hay cambios sin commitear, y los lista: es trabajo del agente que no está
/// en ningún commit, y borrarlo no tiene vuelta atrás. La rama se borra solo si está
/// mergeada (`branch -d`, nunca `-D`); si tiene commits propios, queda.
pub fn remove(repo_hint: &Path, wt: &Worktree, links_dir: &Path, skills_dir: &Path) -> Result<Removed, String> {
    if wt.root.exists() {
        let managed = managed_links(links_dir, skills_dir);
        let dirty = dirty_files(&wt.root, &managed)?;
        if !dirty.is_empty() {
            let shown: Vec<&str> = dirty.iter().take(5).map(String::as_str).collect();
            let more = if dirty.len() > 5 { format!(" y {} más", dirty.len() - 5) } else { String::new() };
            return Err(format!(
                "el worktree tiene cambios sin commitear ({}{more}); commitealos o descartalos antes",
                shown.join(", ")
            ));
        }

        // Los symlinks van primero: son derivados y se recrean solos, pero para git son
        // archivos sin trackear, y con ellos adentro `worktree remove` se niega.
        for link in &managed {
            let _ = std::fs::remove_file(link);
        }
        let _ = std::fs::remove_dir(links_dir);
        if let Some(parent) = links_dir.parent() {
            // `.claude/` o `.agents/` vacía que quedó de haber puesto los symlinks.
            let _ = std::fs::remove_dir(parent);
        }

        git(repo_hint, &["worktree", "remove", &wt.root.to_string_lossy()], GIT_SLOW)?;
    } else {
        // Borrado a mano por fuera de la app: git todavía lo tiene registrado.
        let _ = git(repo_hint, &["worktree", "prune"], GIT_FAST);
    }

    let branch_kept = git(repo_hint, &["branch", "-d", &wt.branch], GIT_FAST).is_err();
    Ok(Removed { branch_kept })
}

/// Traduce las rutas del worktree a las del proyecto, para evaluar reglas.
///
/// Cada worktree vive en otra ruta, así que un "recordar" sobre `Edit(<worktree>/src/a.rs)`
/// no serviría para el agente siguiente, que corre en otro worktree. Traducido, la regla
/// queda `Edit(<proyecto>/src/a.rs)` y vale para todos.
///
/// Solo se traduce `file_path`. Los comandos de `Bash` se comparan tal cual: reescribir
/// adentro de un comando es cambiar lo que el usuario aprobó.
pub fn to_project_paths(input: &serde_json::Value, worktree_root: &Path, repo_root: &Path) -> serde_json::Value {
    let mut out = input.clone();
    if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
        if let Ok(rest) = Path::new(path).strip_prefix(worktree_root) {
            out["file_path"] = serde_json::Value::String(repo_root.join(rest).to_string_lossy().into_owned());
        }
    }
    out
}

/// La raíz del repo del proyecto, deducida sin llamar a git.
///
/// La tarea corre en `<worktree>/<rel>` y el proyecto está en `<repo>/<rel>`: quitándole el
/// mismo `rel` a la carpeta del proyecto queda la raíz del repo. Evita un proceso de git
/// por cada permiso que se evalúa.
pub fn repo_root_from(project_cwd: &Path, task_cwd: &Path, worktree_root: &Path) -> Option<PathBuf> {
    let rel = task_cwd.strip_prefix(worktree_root).ok()?;
    if rel.as_os_str().is_empty() {
        return Some(project_cwd.to_path_buf());
    }
    let project = project_cwd.to_string_lossy();
    let rel = rel.to_string_lossy();
    project
        .strip_suffix(rel.as_ref())
        .map(|p| PathBuf::from(p.trim_end_matches('/')))
}
