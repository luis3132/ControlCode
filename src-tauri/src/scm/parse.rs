//! Leer lo que imprime git. Separado de los comandos para poder probarlo con salidas
//! reales sin tener un repo a mano.

use serde::Serialize;

/// Tope de filas por grupo. Una carpeta `dist/` sin ignorar son miles de archivos sin
/// seguimiento, y dibujarlos todos congela el panel sin decir nada útil.
pub(crate) const MAX_ENTRIES: usize = 3000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmEntry {
    /// Relativa al root del repo, con `/`.
    pub path: String,
    /// De dónde viene, en un renombre o copia.
    pub orig_path: Option<String>,
    /// La letra: M, A, D, R, C, T, U o ?.
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub branch: Option<String>,
    /// El commit actual, abreviado. `None` en un repo sin commits.
    pub head: Option<String>,
    pub detached: bool,
    /// Todavía no hay ningún commit: no hay HEAD contra el cual comparar.
    pub initial: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<ScmEntry>,
    pub unstaged: Vec<ScmEntry>,
    pub untracked: Vec<ScmEntry>,
    pub conflicted: Vec<ScmEntry>,
    /// Algún grupo pasó de `MAX_ENTRIES`.
    pub truncated: bool,
}

fn push(list: &mut Vec<ScmEntry>, truncated: &mut bool, entry: ScmEntry) {
    if list.len() < MAX_ENTRIES {
        list.push(entry);
    } else {
        *truncated = true;
    }
}

/// `git status --porcelain=v2 --branch -z`.
///
/// Es el formato pensado para máquinas: no se traduce, no entrecomilla rutas con `-z`, y
/// trae la rama, el upstream y el adelanto/atraso en la misma salida — sin eso serían
/// cuatro invocaciones por refresco.
pub(crate) fn parse_status_v2(raw: &str) -> StatusInfo {
    let mut info = StatusInfo::default();
    let mut records = raw.split('\0').filter(|r| !r.is_empty());

    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => {
                    if value == "(initial)" {
                        info.initial = true;
                    } else {
                        info.head = Some(value.chars().take(7).collect());
                    }
                }
                "branch.head" => {
                    if value == "(detached)" {
                        info.detached = true;
                    } else {
                        info.branch = Some(value.to_string());
                    }
                }
                "branch.upstream" => info.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split_whitespace() {
                        if let Some(n) = part.strip_prefix('+') {
                            info.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            info.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }

        let kind = record.chars().next().unwrap_or(' ');
        match kind {
            // `1 XY sub mH mI mW hH hI ruta` — la ruta es lo último y puede tener espacios.
            '1' | '2' => {
                let fields = if kind == '1' { 9 } else { 10 };
                let parts: Vec<&str> = record.splitn(fields, ' ').collect();
                if parts.len() < fields {
                    continue;
                }
                let xy = parts[1];
                let path = parts[fields - 1].to_string();
                // En un renombre, con `-z` la ruta de origen viene como registro aparte.
                let orig_path = if kind == '2' { records.next().map(str::to_string) } else { None };
                let mut chars = xy.chars();
                let (x, y) = (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'));
                if x != '.' {
                    push(&mut info.staged, &mut info.truncated, ScmEntry {
                        path: path.clone(),
                        orig_path: orig_path.clone(),
                        status: x.to_string(),
                    });
                }
                if y != '.' {
                    push(&mut info.unstaged, &mut info.truncated, ScmEntry {
                        path,
                        orig_path: None,
                        status: y.to_string(),
                    });
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 ruta` — conflicto sin resolver.
            'u' => {
                let parts: Vec<&str> = record.splitn(11, ' ').collect();
                if let Some(path) = parts.get(10) {
                    push(&mut info.conflicted, &mut info.truncated, ScmEntry {
                        path: path.to_string(),
                        orig_path: None,
                        status: "U".to_string(),
                    });
                }
            }
            '?' => {
                if let Some(path) = record.get(2..) {
                    push(&mut info.untracked, &mut info.truncated, ScmEntry {
                        path: path.to_string(),
                        orig_path: None,
                        status: "?".to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    info
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Como se escribe para cambiar a ella: `main`, `origin/feat`.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    /// Último commit, en epoch de segundos: para ordenar por lo más reciente.
    pub updated_at: i64,
}

/// El formato con que se piden las ramas: campos separados por `\x1f`, una por línea.
pub(crate) const BRANCH_FORMAT: &str =
    "%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(HEAD)";

pub(crate) fn parse_branches(raw: &str) -> Vec<Branch> {
    let mut out: Vec<Branch> = raw
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\u{1f}').collect();
            if f.len() < 5 {
                return None;
            }
            let remote = f[0].starts_with("refs/remotes/");
            // `origin/HEAD` es un puntero, no una rama a la que tenga sentido cambiar.
            if remote && f[0].ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: f[1].to_string(),
                remote,
                current: f[4] == "*",
                upstream: Some(f[2].to_string()).filter(|u| !u.is_empty()),
                updated_at: f[3].parse().unwrap_or(0),
            })
        })
        .collect();
    // Locales antes que remotas, y dentro de cada grupo lo tocado más recientemente arriba:
    // es la rama que se busca casi siempre.
    out.sort_by(|a, b| a.remote.cmp(&b.remote).then(b.updated_at.cmp(&a.updated_at)));
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Epoch en segundos. El "hace 2 h" lo arma la UI, que sabe el idioma.
    pub time: i64,
    pub subject: String,
}

/// Campos separados por `\x1f`, commits por `\x1e`: un asunto puede tener cualquier cosa
/// menos esos dos caracteres de control.
pub(crate) const LOG_FORMAT: &str = "%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e";

pub(crate) fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split('\u{1e}')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let f: Vec<&str> = record.split('\u{1f}').collect();
            if f.len() < 5 {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                subject: f[4].to_string(),
            })
        })
        .collect()
}
