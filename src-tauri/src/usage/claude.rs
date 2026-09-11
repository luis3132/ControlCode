//! El consumo real de Claude Code, leído de sus transcripts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Deserialize;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::types::{AccountUsage, UsageWindow, WINDOWS};

/// Lo único que hace falta de cada línea. El resto del objeto (contenido del mensaje,
/// herramientas, adjuntos) es la mayor parte de los bytes y no se usa, así que `serde` lo
/// descarta sin construirlo.
#[derive(Deserialize)]
struct Line {
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    usage: Option<Usage>,
}

#[derive(Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// La marca que tiene que aparecer en una línea para que valga la pena parsearla.
///
/// Es la optimización que hace viable todo esto: un transcript de una conversación larga
/// son megabytes, y la enorme mayoría de sus líneas son mensajes del usuario, resultados
/// de herramientas y metadatos, ninguno con consumo. Buscar una subcadena cuesta
/// microsegundos; construir el JSON entero para descartarlo, no.
const USAGE_MARK: &str = "\"output_tokens\"";

/// `2026-08-21T20:29:09.363Z` → epoch en segundos.
///
/// Se parsea a mano en vez de sumar una dependencia de fechas: el formato lo escribe la
/// propia TUI, siempre en UTC y siempre igual.
pub(crate) fn parse_ts(raw: &str) -> Option<i64> {
    let (date, rest) = raw.split_once('T')?;
    let time = rest.split(['.', 'Z']).next()?;
    let mut d = date.split('-');
    let (y, mo, da): (i64, i64, i64) =
        (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let mut t = time.split(':');
    let (h, mi, se): (i64, i64, i64) =
        (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);

    // Días desde el epoch por el algoritmo civil de Howard Hinnant: entero puro, sin
    // tablas de meses ni casos especiales para los bisiestos.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some(days * 86_400 + h * 3600 + mi * 60 + se)
}

/// El directorio de configuración de la cuenta: el del perfil, o el de siempre.
fn config_dir(account_id: Option<&str>, db: &DbConnection) -> Result<PathBuf, String> {
    if let Some(id) = account_id {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let dir: String = conn
            .query_row("SELECT dir FROM agent_accounts WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|_| "Cuenta no encontrada".to_string())?;
        return Ok(PathBuf::from(dir));
    }
    // La cuenta principal no tiene fila: es la que usa la TUI cuando nadie le apunta la
    // variable a otro lado. Por eso hasta ahora no aparecía en ningún lado de la UI.
    let home = dirs::home_dir().ok_or_else(|| "No se pudo resolver el home".to_string())?;
    Ok(home.join(".claude"))
}

/// Los transcripts tocados dentro de la ventana más ancha que se va a informar.
///
/// El filtro por fecha de modificación es lo que acota el trabajo: un archivo que no se
/// escribe desde hace una semana no puede tener líneas de esta semana, así que no hace
/// falta ni abrirlo. En un histórico de medio giga eso deja fuera casi todo.
fn recent_transcripts(root: &Path, since: i64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else { return out };

    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let modified = file
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if modified >= since {
                out.push(path);
            }
        }
    }
    out
}

/// El consumo real de una cuenta, por ventana de tiempo.
#[tauri::command]
pub async fn agent_account_usage(
    agent_id: String,
    account_id: Option<String>,
    db: tauri::State<'_, DbConnection>,
) -> Result<AccountUsage, String> {
    // Solo Claude Code escribe el consumo exacto que le devolvió la API. Las demás TUIs
    // no dejan el dato, y devolver ceros se leería como "no gastaste nada".
    if agent_id != "claude-code" {
        return Ok(AccountUsage::unavailable(&agent_id));
    }

    let dir = config_dir(account_id.as_deref(), &db)?;
    let root = dir.join("projects");
    if !root.is_dir() {
        return Ok(AccountUsage {
            available: true,
            ..AccountUsage::unavailable(&agent_id)
        });
    }

    let now = now_ts();
    let widest = WINDOWS.iter().map(|(_, secs)| *secs).max().unwrap_or(0);

    tauri::async_runtime::spawn_blocking(move || {
        let files = recent_transcripts(&root, now - widest);
        let scanned = files.len();

        let mut totals: Vec<UsageWindow> = WINDOWS
            .iter()
            .map(|(key, _)| UsageWindow { key: key.to_string(), ..Default::default() })
            .collect();
        let mut sessions: Vec<HashSet<String>> = WINDOWS.iter().map(|_| HashSet::new()).collect();
        let mut last_activity: Option<i64> = None;

        for path in files {
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            for line in raw.lines() {
                if !line.contains(USAGE_MARK) {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<Line>(line) else { continue };
                let Some(usage) = parsed.message.and_then(|m| m.usage) else { continue };
                let Some(at) = parsed.timestamp.as_deref().and_then(parse_ts) else { continue };

                last_activity = Some(last_activity.map_or(at, |prev: i64| prev.max(at)));

                for (i, (_, secs)) in WINDOWS.iter().enumerate() {
                    if at < now - secs {
                        continue;
                    }
                    let w = &mut totals[i];
                    w.input_tokens += usage.input_tokens;
                    w.output_tokens += usage.output_tokens;
                    w.cache_write_tokens += usage.cache_creation_input_tokens;
                    w.cache_read_tokens += usage.cache_read_input_tokens;
                    w.messages += 1;
                    if let Some(id) = parsed.session_id.as_deref() {
                        sessions[i].insert(id.to_string());
                    }
                }
            }
        }

        for (i, w) in totals.iter_mut().enumerate() {
            w.sessions = sessions[i].len() as u64;
        }

        Ok(AccountUsage {
            agent_id,
            available: true,
            windows: totals,
            last_activity,
            scanned_files: scanned,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
