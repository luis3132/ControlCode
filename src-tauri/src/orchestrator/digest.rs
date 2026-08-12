//! Compresión de la salida de una terminal para que la consuma un modelo (Fase 9).
//!
//! El problema que resuelve: `tab output` devolvía el scrollback crudo de una TUI
//! interactiva. Eso son marcos redibujados, spinners, barras de progreso y secuencias
//! ANSI — muchísimos más tokens de los que aparenta, y casi ninguno con información. Un
//! orquestador que mira tres tabs así agota su contexto antes de haber hecho nada.
//!
//! La compresión es puramente sintáctica y en un solo paso sobre el texto:
//!
//! 1. **Reescritura por `\r`**: una barra de progreso emite `5%\r10%\r15%` sobre UNA
//!    línea física. Visualmente solo queda lo último, así que es lo único que se conserva.
//! 2. **Secuencias ANSI fuera**: color y posicionamiento no le dicen nada al modelo.
//! 3. **Líneas ruido fuera**: vacías y las que son solo un frame de spinner ASCII.
//! 4. **Repetidos consecutivos colapsados** a una línea con `(×N)`. Un redibujado de
//!    pantalla completa reemite las mismas líneas con otro frame de spinner; normalizando
//!    los glifos de spinner antes de comparar, esos marcos colapsan entre sí.
//! 5. **Clasificación**: errores y warnings se extraen aparte, para que sobrevivan aunque
//!    hayan quedado fuera de la cola visible.
//!
//! Nada de esto interpreta el contenido: no hay heurística por agente ni por lenguaje. Un
//! patrón de error mal clasificado es ruido menor; lo que no puede pasar es perder una
//! línea de error, y por eso se extraen antes de recortar la cola.

/// Un error o warning más largo que esto casi siempre trae un stack o un dump: se corta y
/// el modelo puede pedir el crudo con `--raw` si de verdad lo necesita.
pub(crate) const MAX_LINE_CHARS: usize = 400;
const MAX_ERRORS: usize = 20;
const MAX_WARNINGS: usize = 10;

/// Glifos de spinner y de barra de progreso. Se borran ANTES de comparar dos líneas
/// consecutivas (no del texto que se devuelve), que es lo que hace que dos marcos de un
/// redibujado se reconozcan como el mismo.
pub(crate) const SPINNER_GLYPHS: &[char] = &[
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯',
    '⣷', '◐', '◓', '◑', '◒', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '░', '▒', '▓', '▏',
    '▎', '▍', '▌', '▋', '▊', '▉',
];

/// Spinner ASCII clásico: solo cuenta como ruido cuando ES toda la línea. Borrar `|/-\`
/// del texto en general rompería tablas y rutas.
const ASCII_SPINNER: &[&str] = &["|", "/", "-", "\\", "•", "·"];

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum Severity {
    Error,
    Warning,
}

const ERROR_PATTERNS: &[&str] = &[
    "error", "fatal", "panic", "traceback", "exception", "failed", "failure",
    "no such file", "permission denied", "command not found", "cannot find",
    "segmentation fault", "✗", "✖", "❌",
];

const WARNING_PATTERNS: &[&str] = &["warning", "warn:", "warn ", "deprecated", "⚠"];

/// "0 errors" y "compiled without errors" contienen "error" pero son justo lo contrario.
/// Se descartan antes de clasificar, porque un falso positivo acá manda al orquestador a
/// leer el crudo de una tab que no tiene ningún problema.
const NOT_REALLY_ERRORS: &[&str] = &[
    "0 error", "no error", "without error", "sin error", "errors: 0", "0 failed",
    "0 failing", "0 problem", "error: 0",
];

pub struct Digest {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub tail: Vec<String>,
    /// Líneas físicas de la entrada, antes de comprimir.
    pub raw_lines: usize,
    /// Líneas que quedaron tras descartar ruido y colapsar repetidos.
    pub kept_lines: usize,
}

/// Saca las secuencias de escape ANSI y los caracteres de control, conservando `\r`
/// (lo necesita `visible_line` para resolver las reescrituras) y `\t`.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '\x1b' {
            if c == '\t' || c == '\r' || c == '\n' || !c.is_control() {
                out.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: termina en el primer byte del rango final (@ … ~).
            Some('[') => {
                for n in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&n) {
                        break;
                    }
                }
            }
            // OSC (títulos de ventana, hyperlinks): termina en BEL o en ESC \.
            Some(']') => {
                while let Some(n) = chars.next() {
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            // Selección de charset y secuencias de un solo carácter extra.
            Some('(') | Some(')') | Some('#') | Some('%') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

/// Lo que queda VISIBLE de una línea física: sin ANSI y con las reescrituras por `\r`
/// resueltas (solo sobrevive lo escrito después del último retorno de carro).
pub fn visible_line(raw: &str) -> String {
    let stripped = strip_ansi(raw);
    // `str::lines` ya saca el `\r` de un CRLF, pero esta función también se usa sobre
    // fragmentos sueltos, así que se contempla igual.
    let body = stripped.strip_suffix('\r').unwrap_or(&stripped);
    body.rsplit('\r').next().unwrap_or("").trim_end().to_string()
}

fn is_noise_line(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || ASCII_SPINNER.contains(&t)
}

/// Forma canónica para comparar dos líneas consecutivas: sin glifos de spinner y con los
/// espacios colapsados (un redibujado suele cambiar el padding).
fn normalize(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut last_was_space = false;
    for c in line.chars() {
        if SPINNER_GLYPHS.contains(&c) {
            continue;
        }
        if c.is_whitespace() {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(c);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

pub fn classify(line: &str) -> Option<Severity> {
    let lower = line.to_lowercase();
    if NOT_REALLY_ERRORS.iter().any(|p| lower.contains(p)) {
        return None;
    }
    if ERROR_PATTERNS.iter().any(|p| lower.contains(p)) {
        return Some(Severity::Error);
    }
    if WARNING_PATTERNS.iter().any(|p| lower.contains(p)) {
        return Some(Severity::Warning);
    }
    None
}

fn truncate(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(MAX_LINE_CHARS).collect();
    format!("{cut}…")
}

/// Agrega preservando el orden de aparición y colapsando repetidos NO consecutivos (el
/// mismo error emitido tres veces en momentos distintos es una sola señal).
fn push_unique(target: &mut Vec<(String, usize)>, line: &str) {
    if let Some(entry) = target.iter_mut().find(|(t, _)| t == line) {
        entry.1 += 1;
        return;
    }
    target.push((line.to_string(), 1));
}

fn render_counted(entries: Vec<(String, usize)>, max: usize) -> Vec<String> {
    entries
        .into_iter()
        .take(max)
        .map(|(text, count)| {
            if count > 1 {
                format!("{} (×{count})", truncate(&text))
            } else {
                truncate(&text)
            }
        })
        .collect()
}

/// Comprime `raw` y devuelve las señales más la cola visible.
///
/// `tail_lines` acota SOLO la cola: los errores y warnings se extraen del texto completo,
/// así que una falla que ocurrió mil líneas atrás sigue apareciendo.
pub fn digest(raw: &str, tail_lines: usize) -> Digest {
    let mut raw_lines = 0usize;
    let mut kept: Vec<(String, usize)> = Vec::new();
    let mut last_norm = String::new();

    for physical in raw.lines() {
        raw_lines += 1;
        let line = visible_line(physical);
        if is_noise_line(&line) {
            continue;
        }
        let norm = normalize(&line);
        match kept.last_mut() {
            Some(entry) if last_norm == norm => {
                // Se conserva el texto más reciente: en un redibujado, el último marco es
                // el que refleja el estado actual.
                entry.0 = line;
                entry.1 += 1;
            }
            _ => {
                kept.push((line, 1));
                last_norm = norm;
            }
        }
    }

    let rendered: Vec<String> = kept
        .iter()
        .map(|(text, count)| {
            if *count > 1 {
                format!("{} (×{count})", truncate(text))
            } else {
                truncate(text)
            }
        })
        .collect();

    let mut errors: Vec<(String, usize)> = Vec::new();
    let mut warnings: Vec<(String, usize)> = Vec::new();
    for line in &rendered {
        match classify(line) {
            Some(Severity::Error) => push_unique(&mut errors, line),
            Some(Severity::Warning) => push_unique(&mut warnings, line),
            None => {}
        }
    }

    let start = rendered.len().saturating_sub(tail_lines);
    let tail = rendered[start..].to_vec();

    Digest {
        errors: render_counted(errors, MAX_ERRORS),
        warnings: render_counted(warnings, MAX_WARNINGS),
        tail,
        raw_lines,
        kept_lines: rendered.len(),
    }
}

/// Estimación de tokens: ~4 caracteres por token, la regla de bolsillo de los tokenizers
/// BPE para texto latino. Es aproximada a propósito — sirve para que el usuario vea el
/// orden de magnitud de lo que la CLI le está mandando a un modelo, no para facturar.
pub fn estimate_tokens(text: &str) -> u64 {
    text.chars().count().div_ceil(4) as u64
}
