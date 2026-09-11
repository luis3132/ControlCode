//! Sacar los dos porcentajes del panel de `/usage`.
//!
//! ## Por qué no se parsea por líneas
//!
//! La TUI separa sus filas con `\r`, no con `\n` — repinta moviendo el cursor al principio
//! del renglón. Para cualquier función que parta en `\n`, el panel entero es UNA línea, y
//! ahí se rompió el primer intento.
//!
//! Así que no se mira la estructura: se busca el rótulo en el texto plano y se toma el
//! primer porcentaje que venga después. Las columnas, las barras de bloques y el
//! alineado dejan de importar, que es justo lo que hace falta cuando el formato lo decide
//! otro programa.

use super::live::{LiveUsage, Meter};

/// Hasta dónde se busca el porcentaje después de su rótulo. Suficiente para cruzar la
/// barra y su relleno, corto como para no robarle el número a la sección siguiente.
const REACH: usize = 320;

/// Los códigos de escape que mete una TUI, y los bloques con los que dibuja las barras.
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
            // Secuencias de dos caracteres (guardar cursor, juegos de caracteres…).
            Some(_) => i += 2,
            None => break,
        }
    }
    out.chars()
        .filter(|c| !matches!(c, '█' | '▌' | '▊' | '▋' | '▍' | '▎' | '▏' | '▔' | '\u{0f}'))
        .collect()
}

/// El primer `NN% used` dentro del tramo. Devuelve el valor y dónde terminó.
///
/// Se exige la palabra `used` justo después: el panel trae otros porcentajes sueltos —el
/// aviso de promoción dice `+50% weekly limits promo` y cae entre la barra semanal y la
/// siguiente— y sin esa condición uno de esos se leería como el consumo.
fn percent_in(segment: &str) -> Option<(u8, usize)> {
    let mut from = 0;
    while let Some(rel) = segment[from..].find('%') {
        let at = from + rel;
        let after = segment[at + 1..].trim_start();
        if after.starts_with("used") {
            let digits: String = segment[..at]
                .chars()
                .rev()
                .take_while(char::is_ascii_digit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Some(value) = digits.parse::<u8>().ok().filter(|v| *v <= 100) {
                return Some((value, at));
            }
        }
        from = at + 1;
    }
    None
}

/// El `Resets …` que sigue al porcentaje, hasta el fin de su renglón (que acá es `\r`).
fn resets_in(segment: &str) -> Option<String> {
    let at = segment.find("Resets")?;
    let rest = &segment[at + "Resets".len()..];
    let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
    let text = rest[..end].trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// La barra que corresponde a un rótulo.
///
/// Se busca la ÚLTIMA aparición del rótulo: la TUI repinta el panel varias veces mientras
/// lo abre, y la pintada final es la única completa.
fn meter_after(text: &str, marker: &str) -> Option<Meter> {
    let at = text.rfind(marker)? + marker.len();
    let end = (at + REACH).min(text.len());
    // `REACH` puede caer en medio de un carácter multibyte.
    let end = (at..=end).rev().find(|i| text.is_char_boundary(*i))?;
    let segment = &text[at..end];

    let (percent, offset) = percent_in(segment)?;
    Some(Meter { percent, resets: resets_in(&segment[offset..]) })
}

/// Lee el panel: la ventana en curso y la semana. Nada más.
pub(super) fn parse_usage_screen(raw: &str) -> LiveUsage {
    let clean = strip_ansi(raw);

    let session = meter_after(&clean, "Current session");
    // El rótulo completo primero: sin él, `Current week` a secas también pega con las
    // secciones por modelo, y la de un modelo suelto no es el consumo de la semana.
    let week = meter_after(&clean, "Current week (all models)")
        .or_else(|| meter_after(&clean, "Current week"));

    let available = session.is_some() || week.is_some();
    LiveUsage {
        available,
        session,
        week,
        problem: (!available).then(|| "No se encontró el panel de consumo en la salida".to_string()),
    }
}
