//! Sacar las barras del panel de `/usage`.
//!
//! El flujo crudo de la TUI no se puede leer de corrido: las columnas se arman moviendo el
//! cursor y el panel se repinta varias veces mientras carga (ver `screen.rs`). Así que
//! primero se reconstruye la pantalla y recién después se lee, renglón por renglón, que es
//! como se ve:
//!
//! ```text
//!   Current week (all models)
//!   ██████████████████                                 36% used
//!   Resets Sep 20, 10:59am (America/Bogota)
//! ```
//!
//! Se busca el rótulo y su número en los renglones de abajo, sin mirar columnas ni anchos:
//! el formato lo decide otro programa y cambia entre versiones.

use super::live::{LiveUsage, Meter, ModelMeter};
use super::screen::render;

/// Cuántos renglones después del rótulo se busca su porcentaje. La barra va en el
/// siguiente; con tres alcanza si algún día se le mete una línea en el medio, y es poco
/// como para no llegar a la barra siguiente.
const BAR_WITHIN: usize = 3;

/// Cuántos renglones después del porcentaje se busca su reinicio.
const RESETS_WITHIN: usize = 2;

/// El `NN% used` de un renglón.
///
/// Se exige la palabra `used`: el panel trae otros porcentajes —el aviso de promoción dice
/// `+50% weekly limits promo`, y el desglose de abajo, `27% of your usage`— y sin esa
/// condición cualquiera de esos se leería como consumo.
fn percent_used(line: &str) -> Option<u8> {
    let mut from = 0;
    while let Some(rel) = line[from..].find('%') {
        let at = from + rel;
        if line[at + 1..].trim_start().starts_with("used") {
            let digits: String = line[..at]
                .chars()
                .rev()
                .take_while(char::is_ascii_digit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Some(value) = digits.parse::<u8>().ok().filter(|v| *v <= 100) {
                return Some(value);
            }
        }
        from = at + 1;
    }
    None
}

/// El `Resets …` de un renglón, sin la palabra.
fn resets_in(line: &str) -> Option<String> {
    let at = line.find("Resets")?;
    let text = line[at + "Resets".len()..].trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// La barra de un rótulo: su porcentaje y, si lo dice, cuándo se reinicia.
fn meter_at(lines: &[&str], label: usize) -> Option<Meter> {
    let last = (label + BAR_WITHIN).min(lines.len() - 1);
    // Desde el rótulo mismo: en una terminal angosta el número le queda al lado.
    let (at, percent) = (label..=last).find_map(|i| percent_used(lines[i]).map(|p| (i, p)))?;

    let resets_last = (at + RESETS_WITHIN).min(lines.len() - 1);
    let resets = (at..=resets_last).find_map(|i| resets_in(lines[i]));
    Some(Meter { percent, resets })
}

/// El modelo de un rótulo `Current week (Fable)`. `all models` es la semana entera, no un
/// modelo; `Current week` sin paréntesis, tampoco.
fn model_of(label: &str) -> Option<String> {
    let open = label.find('(')?;
    let close = label[open..].find(')')? + open;
    let inside = label[open + 1..close].trim();
    (!inside.is_empty() && !inside.eq_ignore_ascii_case("all models")).then(|| inside.to_string())
}

/// Lee el panel: la ventana en curso, la semana y las semanas por modelo.
///
/// De cada rótulo gana la ÚLTIMA aparición: lo que quedó arriba de la pantalla son pintadas
/// anteriores, y la última es la única completa.
pub(super) fn parse_usage_screen(raw: &str) -> LiveUsage {
    let screen = render(raw);
    let lines: Vec<&str> = screen.lines().map(str::trim).collect();

    let mut session = None;
    let mut week = None;
    let mut models: Vec<ModelMeter> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("Current session") {
            if let Some(meter) = meter_at(&lines, i) {
                session = Some(meter);
            }
        } else if line.starts_with("Current week") {
            let Some(meter) = meter_at(&lines, i) else { continue };
            match model_of(line) {
                None => week = Some(meter),
                Some(model) => match models.iter_mut().find(|m| m.model == model) {
                    Some(existing) => existing.meter = meter,
                    None => models.push(ModelMeter { model, meter }),
                },
            }
        }
    }

    let available = session.is_some() || week.is_some() || !models.is_empty();
    LiveUsage {
        available,
        session,
        week,
        week_models: models,
        problem: (!available).then(|| "No se encontró el panel de consumo en la salida".to_string()),
        ..Default::default()
    }
}
