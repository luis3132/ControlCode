//! Qué se puede lanzar ahora: agentes, modelos y cuentas, con el cupo de cada una.
//!
//! El registro de agentes es estático; esto no. Qué está instalado, qué modelos ofrece cada
//! TUI, qué cuentas tienen sesión y cuánto cupo les queda cambia de un momento a otro, así
//! que se sondea en vez de declararse. Es la foto que mira el ruteo antes de asignar, y la
//! que va a mirar la AI central cuando reparta.
//!
//! Lo caro de sondear (lanzar `opencode models` y `ollama list`) se guarda unos minutos. Lo
//! barato (cuentas, cupo, tareas corriendo) se lee de nuevo cada vez: son filas de la base y
//! un archivo por cuenta, y es justo lo que cambia entre dos tareas lanzadas seguidas.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agents::{ModelSource, AGENTS, SHELL_AGENT_ID};
use crate::database::DbConnection;

use super::agents::adapter_for;
use super::quota::{self, Quota};

/// Cuánto vale lo sondeado. Instalar un modelo es algo que se hace a mano y de vez en
/// cuando; volver a lanzar opencode cada vez que se abre el diálogo sería un segundo de
/// espera para enterarse de lo mismo.
const PROBE_TTL: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub agents: Vec<RosterAgent>,
}

impl Roster {
    pub fn agent(&self, id: &str) -> Option<&RosterAgent> {
        self.agents.iter().find(|a| a.agent_id == id)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterAgent {
    pub agent_id: String,
    pub label: String,
    pub installed: bool,
    /// Se puede correr sin terminal: está instalada Y existe su adaptador.
    pub launchable: bool,
    /// Por qué no se puede lanzar. `None` si se puede.
    pub unavailable: Option<String>,
    pub models: Vec<RosterModel>,
    /// Vacío = la TUI no maneja cuentas: corre con la que tenga el sistema.
    pub accounts: Vec<RosterAccount>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterModel {
    /// Lo que recibe el flag de modelo de la TUI.
    pub id: String,
    pub label: String,
    /// Puede usar herramientas. `Some(false)` = no puede trabajar como agente: leería el
    /// pedido y contestaría con texto, sin tocar un archivo. `None` = no se sabe.
    pub toolcall: Option<bool>,
    /// Corre en esta máquina.
    pub local: bool,
    /// USD por millón de tokens.
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
    pub context: Option<u64>,
    /// Por qué no se puede usar aunque la TUI lo liste (un modelo de Ollama sin descargar).
    pub unavailable: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterAccount {
    /// `None` = la cuenta del sistema.
    pub account_id: Option<String>,
    /// La clave con la que se guarda su cupo (ver `quota::account_key`).
    pub key: String,
    pub name: String,
    /// El mail, cuando la TUI lo expone.
    pub label: Option<String>,
    pub logged_in: bool,
    pub quota: Option<Quota>,
    /// Tareas de la flota que están usando esta cuenta ahora mismo.
    pub running: u32,
}

// ── Los parsers ─────────────────────────────────────────────────

/// Un modelo tal como lo lista `opencode models --verbose`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeModel {
    /// `proveedor/modelo`, lo que recibe `opencode run -m`.
    pub id: String,
    pub provider: String,
    pub name: Option<String>,
    pub toolcall: Option<bool>,
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
    pub context: Option<u64>,
}

/// Traduce la salida de `opencode models --verbose`.
///
/// Verificado contra opencode 1.18.30: una línea `proveedor/modelo` pegada al margen y
/// debajo un objeto JSON indentado, que abre con `{` y cierra con `}` también pegados al
/// margen. Sin `--verbose` salen solo las líneas de id, y eso también se acepta: da modelos
/// sin precio ni capacidades, que es mejor que ningún modelo.
pub fn parse_opencode_models(text: &str) -> Vec<OpencodeModel> {
    let mut models = Vec::new();
    let mut current: Option<(String, String)> = None;

    let flush = |current: &mut Option<(String, String)>, models: &mut Vec<OpencodeModel>| {
        if let Some((id, body)) = current.take() {
            models.push(opencode_model(&id, &body));
        }
    };

    for line in text.lines() {
        let is_header = !line.is_empty()
            && !line.starts_with(char::is_whitespace)
            && !line.starts_with('{')
            && !line.starts_with('}')
            && line.contains('/');
        if is_header {
            flush(&mut current, &mut models);
            current = Some((line.trim().to_string(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut current, &mut models);
    models
}

fn opencode_model(id: &str, body: &str) -> OpencodeModel {
    let provider = id.split('/').next().unwrap_or_default().to_string();
    let meta = serde_json::from_str::<serde_json::Value>(body).ok();
    let get = |ptr: &str| meta.as_ref().and_then(|m| m.pointer(ptr));

    // Un contexto de 0 es lo que opencode pone cuando no lo sabe (así vienen los de
    // Ollama): se informa como desconocido y no como un modelo sin contexto.
    let context = get("/limit/context").and_then(|c| c.as_u64()).filter(|c| *c > 0);
    OpencodeModel {
        id: id.to_string(),
        provider,
        name: get("/name").and_then(|n| n.as_str()).map(str::to_string),
        toolcall: get("/capabilities/toolcall").and_then(|t| t.as_bool()),
        cost_in: get("/cost/input").and_then(|c| c.as_f64()),
        cost_out: get("/cost/output").and_then(|c| c.as_f64()),
        context,
    }
}

/// Los nombres de la tabla de `ollama list` (`NAME  ID  SIZE  MODIFIED`).
pub fn parse_ollama_list(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("NAME"))
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Los modelos de opencode ya cruzados con lo que Ollama tiene de verdad.
///
/// opencode lista los modelos de Ollama que alguien escribió en su configuración, estén
/// descargados o no; en esta máquina lista `ollama/kimi-k2.6:cloud` y `ollama list` no lo
/// tiene. Ofrecerlo daría una tarea que falla al primer mensaje.
///
/// `ollama`: `None` = Ollama no está instalado o no respondió.
pub fn opencode_roster_models(models: &[OpencodeModel], ollama: Option<&[String]>) -> Vec<RosterModel> {
    let pulled: Option<HashSet<&str>> = ollama.map(|names| names.iter().map(String::as_str).collect());

    models
        .iter()
        .map(|m| {
            let is_ollama = m.provider == "ollama";
            let tag = m.id.split_once('/').map(|(_, t)| t).unwrap_or(&m.id);
            let unavailable = match (is_ollama, &pulled) {
                (false, _) => None,
                (true, None) => Some("Ollama no está instalado o no responde".to_string()),
                (true, Some(set)) if !set.contains(tag) => {
                    Some(format!("no está descargado en Ollama (ollama pull {tag})"))
                }
                (true, Some(_)) => None,
            };
            RosterModel {
                id: m.id.clone(),
                label: m.name.clone().unwrap_or_else(|| m.id.clone()),
                toolcall: m.toolcall,
                // Los `:cloud` de Ollama se sirven desde afuera aunque pasen por el
                // Ollama local: no son gratis ni privados.
                local: is_ollama && !tag.ends_with(":cloud"),
                cost_in: m.cost_in,
                cost_out: m.cost_out,
                context: m.context,
                unavailable,
            }
        })
        .collect()
}

// ── El sondeo ───────────────────────────────────────────────────

/// Lo caro: qué hay instalado y qué modelos ofrece cada TUI.
#[derive(Clone)]
struct Probed {
    installed: HashMap<&'static str, bool>,
    models: HashMap<&'static str, Vec<RosterModel>>,
}

lazy_static::lazy_static! {
    static ref PROBED: Mutex<Option<(Instant, Probed)>> = Mutex::new(None);
}

fn probe() -> Probed {
    let mut installed = HashMap::new();
    let mut models = HashMap::new();

    for def in AGENTS.iter().filter(|a| a.id != SHELL_AGENT_ID) {
        let present = crate::agents::command_exists(def.command);
        installed.insert(def.id, present);
        let list = match def.models {
            ModelSource::Aliases(aliases) => aliases
                .iter()
                .map(|a| RosterModel {
                    id: a.id.to_string(),
                    label: a.label.to_string(),
                    toolcall: Some(true),
                    local: false,
                    cost_in: Some(a.cost_in),
                    cost_out: Some(a.cost_out),
                    context: Some(a.context),
                    unavailable: None,
                })
                .collect(),
            ModelSource::OpencodeModels if present => {
                let listed = run(def.command, &["models", "--verbose"])
                    .map(|out| parse_opencode_models(&out))
                    .unwrap_or_default();
                let ollama = run("ollama", &["list"]).map(|out| parse_ollama_list(&out));
                opencode_roster_models(&listed, ollama.as_deref())
            }
            _ => Vec::new(),
        };
        models.insert(def.id, list);
    }
    Probed { installed, models }
}

/// La salida de un comando, o `None` si no está, falla o tarda demasiado.
fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = crate::util::output_with_timeout(crate::util::program(program).args(args), PROBE_TIMEOUT).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn probed(refresh: bool) -> Probed {
    let mut cache = PROBED.lock().unwrap_or_else(|e| e.into_inner());
    if !refresh {
        if let Some((at, hit)) = cache.as_ref() {
            if at.elapsed() < PROBE_TTL {
                return hit.clone();
            }
        }
    }
    let fresh = probe();
    *cache = Some((Instant::now(), fresh.clone()));
    fresh
}

/// La foto de ahora. Bloquea: la primera vez (o con `refresh`) lanza procesos.
pub fn snapshot(db: &DbConnection, refresh: bool) -> Result<Roster, String> {
    let probed = probed(refresh);

    let conn = db.lock().map_err(|e| e.to_string())?;
    let created = crate::accounts::list_accounts(&conn)?;
    let running = running_by_account(&conn)?;

    let agents = AGENTS
        .iter()
        .filter(|a| a.id != SHELL_AGENT_ID)
        .map(|def| {
            let installed = probed.installed.get(def.id).copied().unwrap_or(false);
            let has_adapter = adapter_for(def.id).is_some();
            let unavailable = if !installed {
                Some(format!("{} no está instalado", def.label))
            } else if !has_adapter {
                Some(format!("todavía no se sabe correr {} sin terminal", def.label))
            } else {
                None
            };

            let mut accounts = Vec::new();
            if def.profile.is_some() {
                let system = crate::accounts::system_account(def.id);
                let rows = created.iter().filter(|a| a.agent_id == def.id);
                for (account_id, account) in system
                    .iter()
                    .map(|a| (None, a))
                    .chain(rows.map(|a| (Some(a.id.clone()), a)))
                {
                    let key = quota::account_key(def.id, account_id.as_deref());
                    accounts.push(RosterAccount {
                        quota: quota::load(&conn, &key),
                        running: running.get(&(def.id.to_string(), account_id.clone())).copied().unwrap_or(0),
                        account_id,
                        key,
                        name: account.name.clone(),
                        label: account.label.clone(),
                        logged_in: account.logged_in,
                    });
                }
            }

            RosterAgent {
                agent_id: def.id.to_string(),
                label: def.label.to_string(),
                installed,
                launchable: unavailable.is_none(),
                unavailable,
                models: probed.models.get(def.id).cloned().unwrap_or_default(),
                accounts,
            }
        })
        .collect();

    Ok(Roster { agents })
}

/// Cuántas tareas vivas usa cada (agente, cuenta).
fn running_by_account(conn: &rusqlite::Connection) -> Result<HashMap<(String, Option<String>), u32>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT agent_id, account_id, COUNT(*) FROM tasks
             WHERE status IN ('ready', 'running') GROUP BY agent_id, account_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?), row.get::<_, u32>(2)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}
