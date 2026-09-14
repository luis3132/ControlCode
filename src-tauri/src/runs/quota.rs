//! Cuánto cupo le queda a cada cuenta, según lo que informan las propias tareas.
//!
//! Claude Code, corriendo headless, emite un `rate_limit_event` por sesión con la
//! utilización de las ventanas de 5 horas y de 7 días **y cuándo se reinicia cada una**, en
//! epoch. Es un dato mejor que el del panel de consumo (`usage/live.rs`): aquel hay que
//! levantar la TUI entera para leerlo, y el reinicio viene como texto para humanos ("Resets
//! 3pm (America/Bogota)"). Este llega gratis con cada tarea y se puede comparar con el reloj.
//!
//! Verificado contra una corrida real de la 2.1.269:
//!
//! ```json
//! {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789429800,
//!  "rateLimitType":"five_hour","unifiedWindows":{
//!    "five_hour":{"utilization":0.09,"resetsAt":1789429800},
//!    "seven_day":{"utilization":0.07,"resetsAt":1789920000}}}}
//! ```

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;

/// Lo que dura la ventana corta.
const WINDOW_SECS: i64 = 5 * 3600;

/// Una ventana de límite.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// De 0 a 1. Puede pasarse de 1 si la cuenta usa excedente.
    pub utilization: f64,
    /// Cuándo se reinicia, en epoch de segundos. Pasado ese momento el dato ya no dice nada.
    pub resets_at: Option<i64>,
}

impl QuotaWindow {
    /// La utilización que vale AHORA: una ventana que ya se reinició está en cero, diga lo
    /// que diga el último dato.
    pub fn utilization_at(&self, now: i64) -> f64 {
        match self.resets_at {
            Some(at) if at <= now => 0.0,
            _ => self.utilization,
        }
    }
}

/// Lo último que se supo del cupo de una cuenta.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Quota {
    pub five_hour: Option<QuotaWindow>,
    pub seven_day: Option<QuotaWindow>,
    /// La TUI dijo que ya no deja seguir. Es distinto de mirar la utilización: con
    /// excedente habilitado una cuenta puede pasar el 100 % y seguir.
    pub rejected: bool,
    /// Hasta cuándo, si lo dijo.
    pub rejected_until: Option<i64>,
    /// Puede seguir pasado el 100 % cobrando aparte. En la corrida verificada venía
    /// `overageStatus: "rejected"`, que es el caso de un plan sin excedente.
    pub overage: bool,
    /// Cuándo se observó. Lo pone quien lo guarda: el evento no trae hora propia.
    pub observed_at: i64,
}

impl Quota {
    /// ¿Lanzar ahora con esta cuenta chocaría contra el límite?
    pub fn exhausted_at(&self, now: i64) -> bool {
        // Un rechazo sin fecha de reinicio se da por vencido a las 5 horas de observado: sin
        // un techo, un rechazo viejo dejaría la cuenta fuera de juego para siempre.
        let rejected_now = self.rejected
            && self.rejected_until.map_or(now - self.observed_at < WINDOW_SECS, |until| until > now);
        let full = [&self.five_hour, &self.seven_day]
            .into_iter()
            .flatten()
            .any(|w| w.utilization_at(now) >= 1.0);
        rejected_now || (full && !self.overage)
    }

    /// La utilización de la ventana corta que vale ahora. `None` = nunca se supo.
    pub fn five_hour_at(&self, now: i64) -> Option<f64> {
        self.five_hour.as_ref().map(|w| w.utilization_at(now))
    }
}

/// Traduce un `rate_limit_event`. `None` si la línea no es uno o no trae nada utilizable.
pub fn parse_rate_limit(v: &serde_json::Value) -> Option<Quota> {
    if v.get("type").and_then(|t| t.as_str()) != Some("rate_limit_event") {
        return None;
    }
    let info = v.get("rate_limit_info")?;
    let window = |key: &str| -> Option<QuotaWindow> {
        let w = info.pointer(&format!("/unifiedWindows/{key}"))?;
        Some(QuotaWindow {
            utilization: w.get("utilization")?.as_f64()?,
            resets_at: w.get("resetsAt").and_then(|r| r.as_i64()),
        })
    };

    let rejected = info.get("status").and_then(|s| s.as_str()) == Some("rejected");
    let quota = Quota {
        five_hour: window("five_hour"),
        seven_day: window("seven_day"),
        rejected,
        rejected_until: rejected.then(|| info.get("resetsAt").and_then(|r| r.as_i64())).flatten(),
        overage: info.get("isUsingOverage").and_then(|o| o.as_bool()).unwrap_or(false)
            || info
                .get("overageStatus")
                .and_then(|o| o.as_str())
                .is_some_and(|o| o.starts_with("allowed")),
        observed_at: 0,
    };
    (quota.five_hour.is_some() || quota.seven_day.is_some() || quota.rejected)
        .then_some(quota)
}

/// La clave con la que se identifica una cuenta: la misma que usa el panel de consumo
/// (`AccountUsagePopover`), para que las dos fuentes hablen de la misma cosa.
pub fn account_key(agent_id: &str, account_id: Option<&str>) -> String {
    match account_id {
        Some(id) => id.to_string(),
        None => format!("system:{agent_id}"),
    }
}

fn setting_key(account_key: &str) -> String {
    format!("runs.quota.{account_key}")
}

/// Guarda lo observado. Best-effort: perder un dato de cupo no puede tumbar una tarea.
pub fn record(db: &DbConnection, account_key: &str, mut quota: Quota, now: i64) {
    quota.observed_at = now;
    if let Ok(raw) = serde_json::to_string(&quota) {
        let _ = crate::database::set_setting(db, &setting_key(account_key), &raw);
    }
}

/// Lo último guardado de una cuenta, sobre una conexión ya tomada.
pub fn load(conn: &rusqlite::Connection, account_key: &str) -> Option<Quota> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [setting_key(account_key)],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str(&raw).ok()
}
