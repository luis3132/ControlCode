//! El consumo real de Claude Code, leído de sus transcripts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Deserialize;

use crate::database::DbConnection;
use crate::util::now_ts;

use super::types::{AccountUsage, PlanInfo, UsageWindow, WINDOWS, WINDOW_SECS};

/// Lo único que hace falta de cada línea. El resto del objeto (contenido del mensaje,
/// herramientas, adjuntos) es la mayor parte de los bytes y no se usa, así que `serde` lo
/// descarta sin construirlo.
#[derive(Deserialize)]
struct Line {
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    message: Option<Message>,
    /// Solo aparece cuando el servidor RECHAZA por límite, y es la única vez que dice
    /// cuándo se reabre la ventana. Cuando está, manda sobre lo que deduzcamos nosotros.
    #[serde(rename = "quotaLimits")]
    quota: Option<QuotaLimits>,
}

#[derive(Deserialize)]
struct QuotaLimits {
    #[serde(rename = "resetsAt")]
    resets_at: Option<i64>,
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

/// Lo mismo para el aviso de límite del servidor, que viene en otras líneas.
const QUOTA_MARK: &str = "\"quotaLimits\"";

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

/// Lo que la cuenta dice de sí misma: plan y mail, de su propio `.claude.json`.
///
/// Es el ÚNICO dato real de la cuenta que hay en disco. El cupo que da ese plan —cuántos
/// tokens por ventana— no está en ningún archivo: la TUI se lo pide a la API en caliente y
/// no lo guarda. Por eso acá se informa QUÉ plan es y no cuánto queda de él.
fn read_plan(dir: &Path) -> PlanInfo {
    let Ok(raw) = std::fs::read_to_string(dir.join(".claude.json")) else {
        return PlanInfo::default();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return PlanInfo::default();
    };
    let account = &json["oauthAccount"];
    PlanInfo {
        // El de la organización es el que manda; el del usuario solo aparece en cuentas
        // con asiento propio dentro de una organización.
        tier: account["organizationRateLimitTier"]
            .as_str()
            .or_else(|| account["userRateLimitTier"].as_str())
            .map(str::to_string),
        email: account["emailAddress"].as_str().map(str::to_string),
        extra_usage_enabled: account["hasExtraUsageEnabled"].as_bool().unwrap_or(false),
    }
}

/// Cuándo arrancó la ventana de cinco horas que está corriendo.
///
/// La ventana empieza con el primer mensaje después de que venció la anterior, así que se
/// recorre todo en orden: cada vez que un mensaje cae más allá de cinco horas del arranque
/// vigente, ese mensaje abre una ventana nueva. Lo que queda al final es el arranque de la
/// actual — siempre que el último mensaje siga dentro de ella.
///
/// No es una estimación de consumo: son las marcas de tiempo reales de los mensajes.
pub(crate) fn current_window_start(mut stamps: Vec<i64>, now: i64) -> Option<i64> {
    stamps.sort_unstable();
    let mut start = *stamps.first()?;
    for ts in stamps.iter().copied() {
        if ts - start >= WINDOW_SECS {
            start = ts;
        }
    }
    // Si la última actividad ya quedó fuera, no hay ninguna ventana abierta.
    if now - start >= WINDOW_SECS { None } else { Some(start) }
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

/// Un mensaje con consumo, reducido a lo que suman las ventanas.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsageRecord {
    pub at: i64,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub session: Option<std::sync::Arc<str>>,
}

/// Lo ya leído de un transcript: hasta dónde, y lo que se sacó de ahí.
#[derive(Clone, Debug, Default)]
pub(crate) struct FileScan {
    /// Hasta el final de la última línea completa leída.
    offset: u64,
    pub records: Vec<UsageRecord>,
    /// Avisos de límite del servidor: `(cuándo se vio, cuándo se reinicia)`.
    pub quotas: Vec<(i64, i64)>,
}

lazy_static::lazy_static! {
    /// Los transcripts solo crecen (JSONL que se agrega al final): lo leído no se vuelve a
    /// leer. Antes, abrir el panel de consumo releía la semana entera de cada cuenta, que
    /// en un historial grande son cientos de megas.
    static ref SCANS: std::sync::Mutex<std::collections::HashMap<PathBuf, FileScan>> = Default::default();
}

/// Lee lo que `path` agregó desde `previous` (o todo, si no hay, o si el archivo se achicó:
/// lo reescribieron y lo leído ya no vale). Se detiene en la última línea completa: una
/// línea a medio escribir se lee entera la próxima vez.
pub(crate) fn scan_file(path: &Path, previous: Option<FileScan>) -> FileScan {
    use std::io::{Read, Seek, SeekFrom};
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut scan = previous.filter(|p| p.offset <= len).unwrap_or_default();
    if scan.offset == len {
        return scan;
    }
    let Ok(mut file) = std::fs::File::open(path) else { return scan };
    if file.seek(SeekFrom::Start(scan.offset)).is_err() {
        return FileScan::default();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return scan;
    }
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else { return scan };
    let chunk = String::from_utf8_lossy(&bytes[..end]);
    for line in chunk.lines() {
        // Las dos cosas que interesan: el consumo de un mensaje, y el aviso de límite del
        // servidor. El resto de las líneas no se parsea.
        if !line.contains(USAGE_MARK) && !line.contains(QUOTA_MARK) {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Line>(line) else { continue };
        let Some(at) = parsed.timestamp.as_deref().and_then(parse_ts) else { continue };
        if let Some(resets) = parsed.quota.as_ref().and_then(|q| q.resets_at) {
            scan.quotas.push((at, resets));
        }
        if let Some(usage) = parsed.message.and_then(|m| m.usage) {
            scan.records.push(UsageRecord {
                at,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_write: usage.cache_creation_input_tokens,
                cache_read: usage.cache_read_input_tokens,
                session: parsed.session_id.map(std::sync::Arc::from),
            });
        }
    }
    scan.offset += end as u64 + 1;
    scan
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
        // Las marcas de los mensajes del último día: alcanza y sobra para ubicar el
        // arranque de una ventana de cinco horas, y evita cargar la semana entera.
        let mut recent_stamps: Vec<i64> = Vec::new();
        let mut server_reset: Option<(i64, i64)> = None;

        // Lo leído antes se reusa; de cada archivo solo se lee lo que creció. Los que ya
        // salieron de la semana se olvidan, para que el cache no crezca con el historial.
        let scans: Vec<FileScan> = {
            let mut cache = SCANS.lock().unwrap_or_else(|e| e.into_inner());
            let wanted: HashSet<&PathBuf> = files.iter().collect();
            cache.retain(|p, _| !p.starts_with(&root) || wanted.contains(p));
            files
                .iter()
                .map(|path| {
                    let scan = scan_file(path, cache.remove(path));
                    cache.insert(path.clone(), scan.clone());
                    scan
                })
                .collect()
        };

        for scan in &scans {
            for &(at, resets) in &scan.quotas {
                // Gana el aviso más reciente: los viejos hablan de ventanas que ya se
                // reabrieron.
                if server_reset.is_none_or(|(seen, _)| at > seen) {
                    server_reset = Some((at, resets));
                }
            }
            for record in &scan.records {
                let at = record.at;
                last_activity = Some(last_activity.map_or(at, |prev: i64| prev.max(at)));
                if at >= now - 86_400 {
                    recent_stamps.push(at);
                }
                for (i, (_, secs)) in WINDOWS.iter().enumerate() {
                    if at < now - secs {
                        continue;
                    }
                    let w = &mut totals[i];
                    w.input_tokens += record.input;
                    w.output_tokens += record.output;
                    w.cache_write_tokens += record.cache_write;
                    w.cache_read_tokens += record.cache_read;
                    w.messages += 1;
                    if let Some(id) = record.session.as_deref() {
                        sessions[i].insert(id.to_string());
                    }
                }
            }
        }

        for (i, w) in totals.iter_mut().enumerate() {
            w.sessions = sessions[i].len() as u64;
        }

        let window_started_at = current_window_start(recent_stamps, now);

        Ok(AccountUsage {
            agent_id,
            available: true,
            windows: totals,
            last_activity,
            scanned_files: scanned,
            plan: read_plan(&dir),
            window_started_at,
            window_resets_at: window_started_at.map(|s| s + WINDOW_SECS),
            server_resets_at: server_reset.map(|(_, r)| r),
            server_seen_at: server_reset.map(|(seen, _)| seen),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
