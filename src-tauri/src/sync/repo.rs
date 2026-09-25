//! El clon local del repo de sincronización y lo que git hace con él.
//!
//! Vive en `<datos de la app>/sync/repo`. Nunca se trabaja a mano ahí: la app escribe el
//! árbol mezclado entero, commitea y sube. Todo lo que sale a la red va con la cuenta de
//! git elegida, por las mismas variables de entorno que el resto de la app (el token no
//! se escribe en `.git/config`).

use std::path::{Path, PathBuf};

use super::tree::Tree;
use crate::scm::ScmError;

pub(super) const BRANCH: &str = "main";

pub(super) fn repo_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sync").join("repo")
}

fn msg(e: ScmError) -> String {
    match e {
        ScmError::Auth(m) => format!("git fue rechazado por credenciales: {m}"),
        ScmError::Git(m) => m,
    }
}

fn local(dir: &Path, args: &[&str]) -> Result<String, String> {
    crate::scm::run_local(&dir.to_string_lossy(), args).map_err(msg)
}

/// Commitear sin depender de que el usuario tenga `user.name` configurado en esta máquina.
const IDENTITY: [&str; 4] = ["-c", "user.name=Control Code", "-c", "user.email=sync@controlcode.local"];

pub(super) fn clone(parent: &Path, url: &str, env: &[(String, String)]) -> Result<(), String> {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let dest = parent.join("repo");
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    crate::scm::network_with(
        &parent.to_string_lossy(),
        &["clone", "-q", "--", url, "repo"],
        env,
        std::time::Duration::from_secs(600),
    )
    .map(|_| ())
    .map_err(msg)
}

pub(super) fn fetch(dir: &Path, env: &[(String, String)]) -> Result<(), String> {
    crate::scm::network(&dir.to_string_lossy(), &["fetch", "-q", "origin"], env).map(|_| ()).map_err(msg)
}

/// El commit del remoto, o `None` si el repo está vacío (recién creado).
pub(super) fn remote_head(dir: &Path) -> Option<String> {
    local(dir, &["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{BRANCH}")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Si un commit existe en el clon (la base de un clon borrado y rehecho puede no estar).
pub(super) fn has_commit(dir: &Path, rev: &str) -> bool {
    local(dir, &["cat-file", "-e", &format!("{rev}^{{commit}}")]).is_ok()
}

/// El contenido entero de un commit como árbol. `None` = árbol vacío.
pub(super) fn read_tree(dir: &Path, rev: Option<&str>) -> Result<Tree, String> {
    let mut tree = Tree::new();
    let Some(rev) = rev else { return Ok(tree) };
    let listing = local(dir, &["ls-tree", "-r", "-z", "--name-only", rev])?;
    let root = dir.to_string_lossy();
    for path in listing.split('\0').filter(|p| !p.is_empty()) {
        let bytes = crate::scm::run_bytes(&root, &["show", &format!("{rev}:{path}")]).map_err(msg)?;
        tree.insert(path.to_string(), bytes);
    }
    Ok(tree)
}

/// Deja el clon en la rama sobre `remote` (o en una rama nueva si el repo está vacío), sin
/// cambios locales: lo que había se reemplaza por el árbol mezclado.
pub(super) fn reset_to(dir: &Path, remote: Option<&str>) -> Result<(), String> {
    match remote {
        Some(rev) => local(dir, &["checkout", "-q", "-f", "-B", BRANCH, rev]).map(|_| ()),
        None => {
            // Repo vacío: todavía no hay ningún commit al que pararse.
            if local(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
                local(dir, &["symbolic-ref", "HEAD", &format!("refs/heads/{BRANCH}")]).map(|_| ())
            } else {
                Ok(())
            }
        }
    }
}

/// Escribe el árbol en la carpeta de trabajo, borrando lo que no esté en él.
pub(super) fn write_tree(dir: &Path, tree: &Tree) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    for (rel, bytes) in tree {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Commitea todo lo que cambió. `None` si no había nada que commitear.
pub(super) fn commit_all(dir: &Path, message: &str) -> Result<Option<String>, String> {
    local(dir, &["add", "-A"])?;
    if local(dir, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(None);
    }
    let mut args: Vec<&str> = IDENTITY.to_vec();
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    local(dir, &args)?;
    Ok(Some(local(dir, &["rev-parse", "HEAD"])?.trim().to_string()))
}

pub(super) fn head(dir: &Path) -> Option<String> {
    local(dir, &["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Cómo terminó un push.
pub(super) enum Push {
    Done,
    /// Otra máquina subió algo en el medio: hay que volver a mezclar.
    Behind,
}

pub(super) fn push(dir: &Path, env: &[(String, String)]) -> Result<Push, String> {
    match crate::scm::network(&dir.to_string_lossy(), &["push", "-q", "origin", &format!("HEAD:refs/heads/{BRANCH}")], env) {
        Ok(_) => Ok(Push::Done),
        Err(ScmError::Git(m)) if m.contains("rejected") || m.contains("fetch first") || m.contains("non-fast-forward") => {
            Ok(Push::Behind)
        }
        Err(e) => Err(msg(e)),
    }
}
