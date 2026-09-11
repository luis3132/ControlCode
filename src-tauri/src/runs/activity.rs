//! De qué habla una tarjeta: el stream de eventos condensado a lo que se muestra.
//!
//! Todo acá es puro y sin I/O, que es lo que lo hace testeable sin lanzar un agente ni
//! gastar un peso de API.
//!
//! ## Por qué esto NO es `orchestrator::digest`
//!
//! `digest` comprime la salida de una TUI interactiva: resuelve `\r`, saca ANSI, colapsa
//! marcos de spinner. Es trabajo heroico para adivinar señales entre los pixeles de una
//! terminal, porque ese era el único canal disponible.
//!
//! Acá el canal es otro. Un agente headless emite eventos estructurados, así que "qué
//! archivo tocó" y "qué comando corrió" vienen como datos, no hay que inferirlos. Lo único
//! que hace falta es elegir la forma corta de mostrarlos.

use std::path::Path;

/// La etiqueta corta de un uso de herramienta: `Bash(cargo test)`, `Update(links.rs)`.
///
/// El argumento que se muestra es el que identifica la acción para quien mira, que no es
/// el mismo campo en todas: para las de archivo es la ruta, para `Bash` el comando, para
/// las de búsqueda el patrón. Una herramienta desconocida (de un MCP, por ejemplo) se
/// muestra sin argumento en vez de inventarle uno: es mejor decir menos que mentir.
pub fn tool_label(name: &str, input: &serde_json::Value) -> String {
    let arg = match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => {
            input.get("file_path").and_then(|v| v.as_str()).map(short_path)
        }
        "Bash" | "BashOutput" => input
            .get("command")
            .and_then(|v| v.as_str())
            .map(|c| truncate(first_line(c), 48)),
        "Grep" | "Glob" => input.get("pattern").and_then(|v| v.as_str()).map(|p| truncate(p, 40)),
        "Task" | "Agent" => input.get("description").and_then(|v| v.as_str()).map(|d| truncate(d, 40)),
        "WebFetch" => input.get("url").and_then(|v| v.as_str()).map(|u| truncate(u, 48)),
        _ => None,
    };

    match arg {
        Some(a) if !a.is_empty() => format!("{name}({a})"),
        _ => name.to_string(),
    }
}

/// Las dos últimas partes de una ruta.
///
/// La ruta entera no entra en una tarjeta y el principio es justo lo que menos distingue
/// (todas las tareas de un run comparten el prefijo del proyecto); el final es lo que dice
/// de qué archivo se trata.
fn short_path(path: &str) -> String {
    let p = Path::new(path);
    let file = p.file_name().map(|s| s.to_string_lossy().to_string());
    let parent = p.parent().and_then(|d| d.file_name()).map(|s| s.to_string_lossy().to_string());
    match (parent, file) {
        (Some(d), Some(f)) if !d.is_empty() => format!("{d}/{f}"),
        (_, Some(f)) => f,
        _ => path.to_string(),
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("").trim()
}

fn truncate(s: &str, max: usize) -> String {
    // Por `chars` y no por bytes: cortar a la mitad de un carácter multibyte entrega un
    // string inválido y la tarjeta queda con el reemplazo de Unicode en vez del texto.
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

/// Recorta el texto del agente a lo que cabe en una tarjeta.
///
/// Se queda con el PRINCIPIO y no con el final, al revés que la cola de una terminal: un
/// agente abre diciendo qué va a hacer y cierra con detalle, y en una tarjeta lo que sirve
/// es la intención.
pub fn text_line(text: &str) -> Option<String> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(truncate(first, 96))
}
