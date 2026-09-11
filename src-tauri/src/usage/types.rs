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

/// La ventana de límite de Claude arranca con el primer mensaje y dura cinco horas.
pub const WINDOW_SECS: i64 = 5 * 3600;

/// Lo que la cuenta dice de sí misma, leído de su propia configuración.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    /// El identificador crudo del plan, tal cual lo guarda la TUI
    /// (`default_claude_max_20x`). Se manda sin traducir: el nombre bonito es cosa de la
    /// UI, y si aparece un plan nuevo es mejor mostrar el identificador que "desconocido".
    pub tier: Option<String>,
    pub email: Option<String>,
    pub extra_usage_enabled: bool,
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
    pub plan: PlanInfo,
    /// Cuándo arrancó la ventana de cinco horas en curso, deducido de los propios
    /// mensajes: es el primero que quedó a menos de una ventana del anterior. `None` = no
    /// hay ninguna abierta (hace más de cinco horas que no se usa esta cuenta).
    pub window_started_at: Option<i64>,
    /// Cuándo se reabre. Es `window_started_at` + cinco horas.
    pub window_resets_at: Option<i64>,
    /// Lo ÚLTIMO que dijo el servidor sobre el reinicio, cuando llegó a decir algo: solo
    /// lo manda al rechazar una petición por límite. Viene con su fecha para que la UI
    /// pueda ignorarlo si es viejo — es un dato real pero no necesariamente vigente.
    pub server_resets_at: Option<i64>,
    pub server_seen_at: Option<i64>,
}

impl AccountUsage {
    pub fn unavailable(agent_id: &str) -> Self {
        AccountUsage {
            agent_id: agent_id.to_string(),
            available: false,
            windows: Vec::new(),
            last_activity: None,
            scanned_files: 0,
            plan: PlanInfo::default(),
            window_started_at: None,
            window_resets_at: None,
            server_resets_at: None,
            server_seen_at: None,
        }
    }
}
