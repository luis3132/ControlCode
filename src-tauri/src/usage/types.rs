use serde::Serialize;

/// Las ventanas que se informan. La de 5 horas es la que le importa a quien tiene un plan
/// con límite por ventana; las otras dos dan contexto de si hoy fue un día cargado.
pub const WINDOWS: &[(&str, i64)] = &[
    ("5h", 5 * 3600),
    ("today", 24 * 3600),
    ("7d", 7 * 24 * 3600),
];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// `5h`, `today` o `7d`.
    pub key: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Tokens escritos a la caché de prompt. Se cobran distinto que los de entrada, así
    /// que se informan aparte en vez de sumarlos y perder la distinción.
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub messages: u64,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub agent_id: String,
    /// `false` = esta TUI no deja el dato en disco. El panel lo dice en vez de mostrar
    /// ceros, que se leerían como "no gastaste nada".
    pub available: bool,
    pub windows: Vec<UsageWindow>,
    /// Epoch en segundos del último mensaje con consumo. `None` = nunca se usó.
    pub last_activity: Option<i64>,
    /// Cuántos archivos de transcript se recorrieron. Sirve para explicar una demora.
    pub scanned_files: usize,
}

impl AccountUsage {
    pub fn unavailable(agent_id: &str) -> Self {
        AccountUsage {
            agent_id: agent_id.to_string(),
            available: false,
            windows: Vec::new(),
            last_activity: None,
            scanned_files: 0,
        }
    }
}
