//! En qué carpeta se puede abrir la TUI sin que pregunte nada.
//!
//! Cada cuenta lleva su PROPIA lista de carpetas de confianza, en el `.claude.json` de su
//! perfil. Ahí estaba el fallo con las cuentas alternativas: un perfil recién creado no
//! confía en ninguna, así que al abrir la TUI en la carpeta del proyecto se topaba con el
//! diálogo de "¿confiás en esta carpeta?" y el sondeo se quedaba esperando.
//!
//! La respuesta no es contestarlo por el usuario — el propio diálogo avisa de permisos que
//! la carpeta pre-aprueba. Es abrir el sondeo donde esa cuenta YA dijo que confía.

/// Las carpetas que una cuenta marcó como de confianza, según su `.claude.json`.
pub(super) fn trusted_paths(config: &serde_json::Value) -> Vec<String> {
    let Some(projects) = config.get("projects").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = projects
        .iter()
        .filter(|(_, v)| v.get("hasTrustDialogAccepted").and_then(|t| t.as_bool()) == Some(true))
        .map(|(k, _)| k.clone())
        .collect();
    // Orden estable: sin esto, el sondeo elegiría una carpeta distinta en cada arranque
    // según cómo se haya deserializado el mapa, y un fallo sería imposible de reproducir.
    paths.sort();
    paths
}

/// Dónde abrir el sondeo.
///
/// Gana la carpeta pedida si esa cuenta confía en ella: es la del trabajo en curso y la
/// que menos sorprende. Si no, cualquier otra de su lista que todavía exista — a la TUI le
/// da igual dónde esté parada para contestar `/usage`.
pub(super) fn pick_trusted<'a>(
    trusted: &'a [String],
    requested: Option<&'a str>,
    exists: impl Fn(&str) -> bool,
) -> Option<&'a str> {
    if let Some(cwd) = requested {
        if trusted.iter().any(|t| t == cwd) && exists(cwd) {
            return Some(cwd);
        }
    }
    trusted.iter().map(String::as_str).find(|p| exists(p))
}
