//! A quién le toca una tarea: qué agente, qué modelo y con qué cuenta.
//!
//! Es una función pura sobre la foto del roster. Nada de acá lanza procesos ni lee la base
//! (salvo `load_tiers`/`save_tiers`, que están aparte), así que la política entera se
//! prueba sin gastar un token.
//!
//! ## La política
//!
//! 1. **Si se nombró el modelo, se respeta** — y si no se puede usar, se dice por qué en vez
//!    de cambiarlo por otro a espaldas de quien lo pidió.
//! 2. **Si solo se dijo la complejidad, elige la app** recorriendo la lista del tramo, que
//!    el usuario ordena en Ajustes: la primera opción que se pueda usar ahora.
//! 3. **La capacidad manda sobre el costo.** Un modelo que no puede usar herramientas no
//!    trabaja como agente —contesta con texto y no toca un archivo—, así que se descarta
//!    aunque sea el más barato de la lista. Abaratar hasta romper no es abaratar.
//! 4. **Con el cupo agotado se cambia de cuenta antes que de modelo.** El cupo es un
//!    problema de la cuenta, no de la capacidad: bajar a un modelo peor porque una cuenta
//!    se quedó sin ventana, teniendo otra con cupo, sería perder calidad para nada.
//!
//! `complexity` es un juicio, no un hecho. Por eso cada tarea guarda con qué criterio se la
//! asignó y qué se descartó en el camino: es el dato para ajustar los tramos después. No se
//! ajustan solos — sugerir es útil, decidir a espaldas del usuario no.

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;

use super::roster::{Roster, RosterAccount, RosterAgent};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Trivial,
    Standard,
    Hard,
}

impl Complexity {
    /// De cómo quedó escrita en la fila. `None` si la tarea se lanzó nombrando el modelo.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "trivial" => Some(Complexity::Trivial),
            "standard" => Some(Complexity::Standard),
            "hard" => Some(Complexity::Hard),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Complexity::Trivial => "trivial",
            Complexity::Standard => "standard",
            Complexity::Hard => "hard",
        }
    }
}

/// Un modelo de un agente, como se escribe en un tramo.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub agent_id: String,
    pub model: String,
}

impl ModelRef {
    fn new(agent_id: &str, model: &str) -> Self {
        ModelRef { agent_id: agent_id.to_string(), model: model.to_string() }
    }
}

/// Qué modelos probar para cada complejidad, en orden de preferencia.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tiers {
    pub trivial: Vec<ModelRef>,
    pub standard: Vec<ModelRef>,
    pub hard: Vec<ModelRef>,
}

impl Default for Tiers {
    /// Una clase por tramo, de la TUI que hoy se sabe correr. Fable queda afuera a
    /// propósito: cuesta el doble que Opus, y en los planes de suscripción tiene su propia
    /// semana aparte. Quien lo quiera para lo difícil lo agrega adelante.
    fn default() -> Self {
        Tiers {
            trivial: vec![ModelRef::new("claude-code", "haiku")],
            standard: vec![ModelRef::new("claude-code", "sonnet")],
            hard: vec![ModelRef::new("claude-code", "opus")],
        }
    }
}

impl Tiers {
    pub fn get(&self, c: Complexity) -> &[ModelRef] {
        match c {
            Complexity::Trivial => &self.trivial,
            Complexity::Standard => &self.standard,
            Complexity::Hard => &self.hard,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum AccountChoice {
    /// La que convenga: con sesión, con cupo, y la menos cargada.
    Auto,
    /// Esa. `None` = la del sistema.
    Fixed(Option<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RouteRequest {
    /// Obligatorio si se nombra el modelo. Con solo complejidad, restringe el tramo a ese
    /// agente; sin él, vale cualquiera.
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub complexity: Option<Complexity>,
    pub account: AccountChoice,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RoutedBy {
    /// Lo nombró quien lanzó la tarea.
    Manual,
    /// La primera opción del tramo.
    Policy,
    /// Hubo que descartar algo del tramo: un modelo o una cuenta.
    Fallback,
}

impl RoutedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            RoutedBy::Manual => "manual",
            RoutedBy::Policy => "policy",
            RoutedBy::Fallback => "fallback",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub agent_id: String,
    /// `None` = el modelo por defecto de la TUI.
    pub model: Option<String>,
    /// `None` = la cuenta del sistema.
    pub account_id: Option<String>,
    pub routed_by: RoutedBy,
    /// Lo que se descartó y por qué, en el orden en que se probó. Vacío si salió a la
    /// primera.
    pub notes: Vec<String>,
}

/// Asigna una tarea. `Err` trae el motivo en palabras: es lo que se le muestra a quien la
/// lanzó, así que tiene que alcanzar para saber qué cambiar.
pub fn route(roster: &Roster, tiers: &Tiers, req: &RouteRequest, now: i64) -> Result<Assignment, String> {
    match (&req.model, req.complexity) {
        (Some(_), _) | (None, None) => manual(roster, req, now),
        (None, Some(c)) => by_tier(roster, tiers, req, c, now),
    }
}

fn manual(roster: &Roster, req: &RouteRequest, now: i64) -> Result<Assignment, String> {
    let agent_id = req.agent_id.as_deref().ok_or("falta decir qué agente la corre")?;
    let agent = roster.agent(agent_id).ok_or_else(|| format!("'{agent_id}' no es un agente conocido"))?;
    if let Some(reason) = &agent.unavailable {
        return Err(reason.clone());
    }
    if let Some(model) = &req.model {
        model_problem(agent, model).map_or(Ok(()), Err)?;
    }
    let (account_id, notes) = pick_account(agent, &req.account, now)?;
    Ok(Assignment {
        agent_id: agent.agent_id.clone(),
        model: req.model.clone(),
        account_id,
        routed_by: RoutedBy::Manual,
        notes,
    })
}

fn by_tier(
    roster: &Roster,
    tiers: &Tiers,
    req: &RouteRequest,
    complexity: Complexity,
    now: i64,
) -> Result<Assignment, String> {
    let entries: Vec<&ModelRef> = tiers
        .get(complexity)
        .iter()
        .filter(|e| req.agent_id.as_deref().is_none_or(|id| id == e.agent_id))
        .collect();
    if entries.is_empty() {
        return Err(match &req.agent_id {
            Some(id) => format!("el tramo {} no tiene modelos de '{id}'", complexity.as_str()),
            None => format!("el tramo {} no tiene modelos", complexity.as_str()),
        });
    }

    let mut notes = Vec::new();
    for entry in entries {
        let what = format!("{} ({})", entry.model, entry.agent_id);
        let Some(agent) = roster.agent(&entry.agent_id) else {
            notes.push(format!("{what}: no es un agente conocido"));
            continue;
        };
        if let Some(reason) = &agent.unavailable {
            notes.push(format!("{what}: {reason}"));
            continue;
        }
        if let Some(problem) = model_problem(agent, &entry.model) {
            notes.push(format!("{what}: {problem}"));
            continue;
        }
        match pick_account(agent, &req.account, now) {
            Ok((account_id, account_notes)) => {
                notes.extend(account_notes);
                return Ok(Assignment {
                    agent_id: agent.agent_id.clone(),
                    model: Some(entry.model.clone()),
                    account_id,
                    routed_by: if notes.is_empty() { RoutedBy::Policy } else { RoutedBy::Fallback },
                    notes,
                });
            }
            Err(reason) => notes.push(format!("{what}: {reason}")),
        }
    }

    Err(format!(
        "ningún modelo del tramo {} se puede usar ahora — {}",
        complexity.as_str(),
        notes.join("; ")
    ))
}

/// Por qué no se puede usar un modelo de un agente. `None` = se puede.
///
/// Un modelo que el roster no lista NO es un problema: `claude --model` acepta nombres
/// completos (`claude-sonnet-5`) además de los alias, y rechazarlos por no estar en la
/// lista sería saber menos que la propia TUI.
fn model_problem(agent: &RosterAgent, model: &str) -> Option<String> {
    let listed = agent.models.iter().find(|m| m.id == model)?;
    if let Some(reason) = &listed.unavailable {
        return Some(reason.clone());
    }
    (listed.toolcall == Some(false))
        .then(|| "no puede usar herramientas: contestaría con texto sin tocar un archivo".to_string())
}

/// Con qué cuenta. Devuelve la cuenta y lo que se descartó para llegar a ella.
fn pick_account(
    agent: &RosterAgent,
    choice: &AccountChoice,
    now: i64,
) -> Result<(Option<String>, Vec<String>), String> {
    // Una TUI sin cuentas corre con la que tenga el sistema: no hay nada que elegir.
    if agent.accounts.is_empty() {
        return match choice {
            AccountChoice::Fixed(Some(id)) => Err(format!("{} no maneja cuentas: '{id}' no existe", agent.label)),
            _ => Ok((None, Vec::new())),
        };
    }

    match choice {
        AccountChoice::Fixed(id) => {
            let account = agent
                .accounts
                .iter()
                .find(|a| &a.account_id == id)
                .ok_or("la cuenta elegida ya no existe")?;
            account_problem(account, now).map_or(Ok(()), Err)?;
            Ok((account.account_id.clone(), Vec::new()))
        }
        AccountChoice::Auto => {
            let mut notes = Vec::new();
            let mut usable: Vec<(usize, &RosterAccount)> = Vec::new();
            for (order, account) in agent.accounts.iter().enumerate() {
                match account_problem(account, now) {
                    Some(problem) => notes.push(problem),
                    None => usable.push((order, account)),
                }
            }
            // Primero la que tiene más ventana libre, pero en escalones de 10 %: entre 9 y
            // 11 % no hay diferencia que valga repartir por ella, y así el desempate lo
            // deciden las tareas que ya están corriendo — que son las que van a gastar la
            // ventana en los próximos minutos. Un cupo desconocido cuenta como libre: es una
            // cuenta que la flota todavía no usó.
            usable.sort_by_key(|(order, a)| {
                let used = a.quota.as_ref().and_then(|q| q.five_hour_at(now)).unwrap_or(0.0);
                ((used * 10.0).floor() as i64, a.running, *order)
            });
            match usable.first() {
                Some((_, account)) => Ok((account.account_id.clone(), notes)),
                None => Err(format!("ninguna cuenta de {} se puede usar — {}", agent.label, notes.join("; "))),
            }
        }
    }
}

fn account_problem(account: &RosterAccount, now: i64) -> Option<String> {
    // La del sistema se llama como la TUI ("Claude Code"), y "la cuenta Claude Code agotó su
    // cupo" no dice cuál de las de Claude Code. Se nombra como en el selector de cuentas.
    let name = match account.account_id {
        None => "principal",
        Some(_) => account.name.as_str(),
    };
    if !account.logged_in {
        return Some(format!("la cuenta {name} no tiene sesión iniciada"));
    }
    let quota = account.quota.as_ref()?;
    if !quota.exhausted_at(now) {
        return None;
    }
    let reset = [quota.rejected_until, quota.five_hour.as_ref().and_then(|w| w.resets_at)]
        .into_iter()
        .flatten()
        .filter(|at| *at > now)
        .min();
    Some(match reset {
        Some(at) => format!("la cuenta {name} agotó su cupo (se reinicia en {})", minutes(at - now)),
        None => format!("la cuenta {name} agotó su cupo"),
    })
}

fn minutes(secs: i64) -> String {
    let mins = (secs + 59) / 60;
    if mins < 60 {
        format!("{mins} min")
    } else {
        format!("{} h {:02} min", mins / 60, mins % 60)
    }
}

// ── Los tramos guardados ────────────────────────────────────────

const TIERS_KEY: &str = "runs.routing.tiers";

/// Los tramos de Ajustes, o los de fábrica si nunca se tocaron o el guardado no se entiende.
pub fn load_tiers(db: &DbConnection) -> Tiers {
    crate::database::get_setting(db, TIERS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_tiers(db: &DbConnection, tiers: &Tiers) -> Result<(), String> {
    let raw = serde_json::to_string(tiers).map_err(|e| e.to_string())?;
    crate::database::set_setting(db, TIERS_KEY, &raw)
}
