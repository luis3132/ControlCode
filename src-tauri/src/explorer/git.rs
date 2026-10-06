//! Qué repo es esta carpeta, en qué rama está, y qué cambió.
//!
//! Todo sale de invocar `git`. Se podría linkear una librería, pero `git` ya está
//! instalado en cualquier máquina donde esta app tenga sentido, y así el resultado es
//! exactamente el que ve el usuario en su terminal — incluido lo que diga su
//! `.gitignore` y su configuración.

use std::collections::HashMap;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::util::output_with_timeout;

/// Un repo grande con el índice frío puede tardar; más de esto y el panel prefiere
/// mostrarse sin marcas antes que congelarse.
const GIT_TIMEOUT: Duration = Duration::from_secs(4);

/// El estado de una ruta en el árbol de trabajo, resumido a una letra para el panel.
/// `git status` da dos (índice y árbol); acá gana la más "fuerte" porque el panel tiene
/// una sola columna.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileMark {
    /// Conflicto de merge. Va primero: es lo único que bloquea trabajar.
    Conflict,
    Added,
    Modified,
    Deleted,
    Untracked,
}

impl FileMark {
    /// La letra que se dibuja. Coincide con la de `git status` para que no haya que
    /// aprender un alfabeto nuevo.
    pub fn letter(self) -> &'static str {
        match self {
            FileMark::Conflict => "U",
            FileMark::Added => "A",
            FileMark::Modified => "M",
            FileMark::Deleted => "D",
            FileMark::Untracked => "?",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// `None` = la carpeta no está en ningún repo. El panel sigue funcionando, sin marcas.
    pub root: Option<String>,
    /// El directorio de git de esta carpeta (`.git`, o `.git/worktrees/x` en un worktree).
    /// Lo vigila el panel para refrescar las marcas cuando alguien hace `add` o `commit`.
    pub git_dir: Option<String>,
    pub branch: Option<String>,
    /// Un worktree enlazado, no el checkout principal. Es lo que distingue un workspace
    /// "PRIMARY" de uno derivado.
    pub is_worktree: bool,
    /// Ruta relativa al root → letra. Se manda plano en vez de anidado porque el panel
    /// resuelve por prefijo para marcar también las carpetas que contienen cambios.
    pub changes: HashMap<String, String>,
    /// Cuántas rutas cambiaron. Se manda aparte para no obligar al panel a contar un
    /// mapa que puede tener miles de entradas.
    pub changed_count: usize,
}

impl RepoInfo {
    fn none() -> Self {
        RepoInfo { root: None, git_dir: None, branch: None, is_worktree: false, changes: HashMap::new(), changed_count: 0 }
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    let out = output_with_timeout(&mut cmd, GIT_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_string())
}

/// Traduce las dos columnas de `git status --porcelain` a una sola marca.
pub(crate) fn mark_from_xy(xy: &str) -> Option<FileMark> {
    let mut chars = xy.chars();
    let x = chars.next()?;
    let y = chars.next()?;

    // Conflicto: cualquiera de las combinaciones con `U`, más `AA` y `DD`.
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return Some(FileMark::Conflict);
    }
    if x == '?' {
        return Some(FileMark::Untracked);
    }
    // El índice manda sobre el árbol: un archivo agregado y luego editado se lee mejor
    // como "agregado" que como "modificado".
    match (x, y) {
        ('A', _) => Some(FileMark::Added),
        ('D', _) | (_, 'D') => Some(FileMark::Deleted),
        ('R', _) | ('C', _) => Some(FileMark::Added),
        ('M', _) | (_, 'M') => Some(FileMark::Modified),
        (' ', ' ') => None,
        _ => Some(FileMark::Modified),
    }
}

/// Parsea la salida `-z` de `git status --porcelain`.
///
/// El formato es `XY<espacio>ruta\0`, y en un rename vienen DOS rutas: primero la nueva,
/// después la vieja, cada una con su `\0`. Sin consumir esa segunda, la ruta original se
/// leería como si fuera otra entrada y se perdería la sincronización de todo el resto.
pub(crate) fn parse_status_z(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut parts = raw.split('\0').filter(|s| !s.is_empty()).peekable();

    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let (xy, rest) = record.split_at(2);
        let path = rest.trim_start_matches(' ');
        let renamed = xy.starts_with('R') || xy.starts_with('C');
        if renamed {
            // La ruta de origen; se descarta, pero hay que sacarla del iterador.
            parts.next();
        }
        if let Some(mark) = mark_from_xy(xy) {
            out.insert(path.to_string(), mark.letter().to_string());
        }
    }
    out
}

/// La rama del encabezado `## …` de `git status --branch`. `None` con HEAD desprendido.
///
/// Formas que da git: `main`, `main...origin/main [ahead 1]`, `No commits yet on main`
/// (repo recién creado; versiones viejas dicen `Initial commit on main`) y
/// `HEAD (no branch)`.
pub(crate) fn branch_from_header(header: &str) -> Option<String> {
    let rest = header.strip_prefix("## ")?;
    if rest.starts_with("HEAD (no branch)") {
        return None;
    }
    for unborn in ["No commits yet on ", "Initial commit on "] {
        if let Some(name) = rest.strip_prefix(unborn) {
            return Some(name.to_string());
        }
    }
    let end = rest.find("...").or_else(|| rest.find(' ')).unwrap_or(rest.len());
    Some(rest[..end].to_string()).filter(|b| !b.is_empty())
}

/// Todo lo que el panel necesita saber de la carpeta: repo, rama y cambios.
///
/// Dos procesos de git y no cinco: cada uno cuesta un fork y, en un repo grande, leer el
/// índice. `rev-parse` responde varias preguntas de una (una línea por cada una, en
/// orden), y la rama sale del encabezado de `status --branch`, que a diferencia de
/// `rev-parse --abbrev-ref HEAD` también funciona en un repo sin commits.
///
/// `--no-optional-locks`: el `status` no toma `index.lock` para refrescar el índice. Sin
/// eso competía con los agentes que hacen `git add`/`commit` en la misma carpeta, y uno
/// de los dos fallaba con "index.lock exists".
pub fn explorer_repo_info(path: String) -> Result<RepoInfo, String> {
    let Some(dirs) = git(
        &path,
        &["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"],
    ) else {
        // No es un repo (o no hay `git`). No es un error: se muestra el árbol pelado.
        return Ok(RepoInfo::none());
    };
    let mut lines = dirs.lines();
    let (Some(root), own, common) = (lines.next(), lines.next(), lines.next()) else {
        return Ok(RepoInfo::none());
    };
    // En un worktree enlazado, el directorio de git propio y el común difieren. Es la
    // señal fiable: mirar si `.git` es archivo o carpeta falla con submódulos.
    let is_worktree = matches!((own, common), (Some(own), Some(common)) if own != common);

    let status = git(&path, &["--no-optional-locks", "status", "--porcelain", "-z", "--branch", "--untracked-files=normal"])
        .unwrap_or_default();
    let (header, entries) = match status.split_once('\0') {
        Some((first, rest)) if first.starts_with("## ") => (Some(first), rest),
        _ => (None, status.as_str()),
    };
    let branch = header.and_then(branch_from_header);
    let changes = parse_status_z(entries);

    Ok(RepoInfo {
        root: Some(root.to_string()),
        git_dir: own.map(str::to_string),
        branch,
        is_worktree,
        changed_count: changes.len(),
        changes,
    })
}
