//! Buscar texto en los archivos del workspace, como el buscador de VS Code.
//!
//! Recorre con `ignore` —el mismo motor de ripgrep— así que respeta `.gitignore` sin
//! invocar a git: funciona igual en una carpeta que no es repo. Busca línea por línea con
//! `regex`; una búsqueda literal es una regex escapada, para no tener dos caminos.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// Cuántas coincidencias se devuelven como máximo. Más que esto no se lee: se afina la
/// búsqueda. Y cada una viaja por IPC con su línea, así que el tope también cuida eso.
const MAX_MATCHES: usize = 2000;

/// Por archivo: un minificado con mil `a` no puede llevarse todo el cupo.
const MAX_PER_FILE: usize = 100;

/// Un archivo más grande que esto no es código que alguien esté leyendo.
const MAX_FILE: u64 = 1024 * 1024;

/// Largo de la vista previa de una línea. Las líneas de un bundle miden megas.
const PREVIEW_BEFORE: usize = 40;
const PREVIEW_AFTER: usize = 160;

/// Carpetas que no se recorren aunque no estén en `.gitignore`. Es el `search.exclude` de
/// VS Code por defecto: nadie busca adentro de `node_modules` a propósito.
const ALWAYS_SKIP: &[&str] = &[".git", "node_modules"];

/// La búsqueda vigente de cada ventana. Tipear lanza una búsqueda nueva por tecla; la
/// anterior se entera acá de que ya nadie la espera y corta en el próximo archivo.
static GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root: String,
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Globs separados por coma, como en VS Code (`src/**, *.ts`).
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based, como se muestra.
    pub line: u32,
    /// Columna del comienzo en unidades UTF-16: es lo que usan JS y CodeMirror para ubicar
    /// el cursor. En bytes, una línea con tildes o emojis dejaría el cursor corrido.
    pub column: u32,
    /// La línea recortada alrededor de la coincidencia.
    pub preview: String,
    /// Dónde resaltar dentro de `preview`, también en UTF-16.
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    /// Relativa al root, con `/`: es lo que se muestra.
    pub rel: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub match_count: usize,
    /// Se llegó al tope: hay más de lo que se muestra.
    pub truncated: bool,
    /// La reemplazó otra búsqueda. La UI la descarta.
    pub cancelled: bool,
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// El índice de byte más cercano hacia atrás que cae en un límite de carácter.
fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Recorta la línea alrededor de la coincidencia (bytes `start..end`) y devuelve la vista
/// previa con el rango a resaltar en UTF-16.
pub(crate) fn preview_of(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let indent = line.len() - line.trim_start().len();
    let from = floor_char(line, start.saturating_sub(PREVIEW_BEFORE).max(indent.min(start)));
    let to = ceil_char(line, (end + PREVIEW_AFTER).min(line.len()));
    let prefix = if from > indent { "…" } else { "" };
    let suffix = if to < line.len() { "…" } else { "" };

    let body = &line[from..to];
    let preview = format!("{prefix}{body}{suffix}");
    let s = utf16_len(prefix) + utf16_len(&line[from..start]);
    let e = s + utf16_len(&line[start..end]);
    (preview, s, e)
}

pub(crate) fn build_regex(q: &SearchQuery) -> Result<Regex, String> {
    let pattern = if q.is_regex { q.query.clone() } else { regex::escape(&q.query) };
    let pattern = if q.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        // Una regex patológica tipeada a medias no puede comerse la memoria.
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| format!("expresión regular inválida: {e}"))
}

fn globs(list: &str) -> impl Iterator<Item = &str> {
    list.split(',').map(str::trim).filter(|g| !g.is_empty())
}

/// La búsqueda en sí. `is_stale` se consulta entre archivo y archivo.
pub(crate) fn search(q: &SearchQuery, is_stale: impl Fn() -> bool) -> Result<SearchResult, String> {
    let mut result = SearchResult::default();
    if q.query.is_empty() {
        return Ok(result);
    }
    let re = build_regex(q)?;
    let root = Path::new(&q.root);

    let mut overrides = OverrideBuilder::new(root);
    for g in globs(&q.include) {
        overrides.add(g).map_err(|e| format!("glob inválido «{g}»: {e}"))?;
    }
    for g in globs(&q.exclude) {
        overrides.add(&format!("!{g}")).map_err(|e| format!("glob inválido «{g}»: {e}"))?;
    }
    let overrides = overrides.build().map_err(|e| e.to_string())?;

    let walker = WalkBuilder::new(root)
        // Los archivos ocultos se buscan (`.env.example`, `.github/`): lo que se saltea lo
        // decide `.gitignore`, igual que en el editor.
        .hidden(false)
        .require_git(false)
        .overrides(overrides)
        .filter_entry(|e| !ALWAYS_SKIP.iter().any(|skip| e.file_name() == *skip))
        .build();

    for entry in walker {
        if is_stale() {
            result.cancelled = true;
            return Ok(result);
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else { continue };
        if super::files::looks_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);

        let mut matches = Vec::new();
        for (idx, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                // Una regex que calza vacío (`^`, `a*`) coincidiría en cada línea sin
                // mostrar nada: no es un resultado.
                if m.start() == m.end() {
                    continue;
                }
                let (preview, start, end) = preview_of(line, m.start(), m.end());
                matches.push(SearchMatch {
                    line: idx as u32 + 1,
                    column: utf16_len(&line[..m.start()]),
                    preview,
                    start,
                    end,
                });
                result.match_count += 1;
                if matches.len() >= MAX_PER_FILE || result.match_count >= MAX_MATCHES {
                    break;
                }
            }
            if matches.len() >= MAX_PER_FILE || result.match_count >= MAX_MATCHES {
                break;
            }
        }

        if !matches.is_empty() {
            let rel = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            result.files.push(FileMatches {
                path: entry.path().to_string_lossy().to_string(),
                rel,
                matches,
            });
        }
        if result.match_count >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
    }

    // El recorrido no tiene orden garantizado; la lista sí tiene que tenerlo o salta de
    // lugar entre una tecla y la siguiente.
    result.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(result)
}

#[tauri::command]
pub async fn explorer_search(window: tauri::Window, query: SearchQuery) -> Result<SearchResult, String> {
    let label = window.label().to_string();
    let generation = {
        let mut gens = GENERATIONS.lock().map_err(|e| e.to_string())?;
        let next = gens.get(&label).copied().unwrap_or(0) + 1;
        gens.insert(label.clone(), next);
        next
    };

    tauri::async_runtime::spawn_blocking(move || {
        search(&query, || {
            GENERATIONS
                .lock()
                .map(|gens| gens.get(&label).copied() != Some(generation))
                .unwrap_or(false)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
