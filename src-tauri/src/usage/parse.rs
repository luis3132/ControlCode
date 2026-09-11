//! Sacar los números del panel de `/usage`.
//!
//! Vive separado del que abre la PTY para poder probarlo con capturas reales, que es la
//! única forma seria de defender un parseo de pantalla: el formato lo decide otro programa
//! y puede cambiar sin aviso.

use super::live::{LiveUsage, Meter};

/// Los códigos de escape que mete una TUI. Se quitan antes de buscar nada: el texto viene
/// salpicado de secuencias de color y de posicionamiento en medio de las palabras.
pub(super) fn strip_ansi(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i] as char);
            i += 1;
            continue;
        }
        i += 1;
        match bytes.get(i) {
            // CSI: termina en la primera letra.
            Some(b'[') => {
                i += 1;
                while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
                i += 1;
            }
            // OSC: termina en BEL o en ST.
            Some(b']') => {
                while i < bytes.len() && bytes[i] != 0x07 {
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            // Secuencias de dos caracteres (juegos de caracteres, modos de teclado).
            Some(_) => i += 2,
            None => break,
        }
    }
    // El texto real queda mezclado con los bloques de las barras; se sacan acá para que no
    // ensucien ni las etiquetas ni los números.
    out.chars().filter(|c| !matches!(c, '█' | '▌' | '▊' | '▋' | '▍' | '▎' | '▏' | '▔' | '\u{0f}')).collect()
}

/// `3% used`, `3%used`, `69 % used` → 3, 3, 69.
fn percent_in(line: &str) -> Option<u8> {
    let at = line.find('%')?;
    // El panel escribe "used" después del número; sin esa palabra es otra cosa.
    if !line[at..].contains("used") {
        return None;
    }
    let digits: String = line[..at]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok().filter(|p| *p <= 100)
}

/// `Resets Sep 13, 11am (America/Bogota)` → el texto tal cual, sin la palabra `Resets`.
fn resets_in(line: &str) -> Option<String> {
    let at = line.find("Resets")?;
    let text = line[at + "Resets".len()..].trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// El modelo de un encabezado `Current week (Fable)`. `all models` no es un modelo.
fn week_model(line: &str) -> Option<String> {
    let open = line.find('(')?;
    let close = line[open..].find(')')? + open;
    let inside = line[open + 1..close].trim();
    (!inside.eq_ignore_ascii_case("all models")).then(|| inside.to_string())
}

/// Una barra: el porcentaje, y el `Resets` que venga en las líneas siguientes.
fn meter_from(lines: &[&str], from: usize) -> Option<(Meter, usize)> {
    // El porcentaje puede estar en la misma línea del encabezado o poco más abajo; el
    // límite evita que una sección se coma la barra de la siguiente.
    let end = (from + 4).min(lines.len());
    let at = (from..end).find(|i| percent_in(lines[*i]).is_some())?;
    let percent = percent_in(lines[at])?;
    let resets = ((at + 1)..(at + 3).min(lines.len())).find_map(|i| resets_in(lines[i]));
    Some((Meter { percent, resets }, at))
}

/// Lee el panel entero.
pub(super) fn parse_usage_screen(raw: &str) -> LiveUsage {
    let clean = strip_ansi(raw);
    let lines: Vec<&str> = clean.lines().map(str::trim).collect();

    let mut usage = LiveUsage { available: false, ..Default::default() };

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("Current session") {
            if let Some((meter, _)) = meter_from(&lines, i) {
                usage.session = Some(meter);
            }
        } else if line.starts_with("Current week") {
            let Some((meter, _)) = meter_from(&lines, i) else { continue };
            match week_model(line) {
                // Solo el primero de cada clase: el panel puede repetir encabezados al
                // redibujarse, y el de más arriba es el completo.
                Some(model) if usage.week_model.is_none() => {
                    usage.week_model = Some(model);
                    usage.week_model_meter = Some(meter);
                }
                None if usage.week.is_none() => usage.week = Some(meter),
                _ => {}
            }
        }
    }

    usage.available = usage.session.is_some() || usage.week.is_some();
    if !usage.available {
        usage.problem = Some("No se encontró el panel de consumo en la salida".to_string());
    }
    usage
}
