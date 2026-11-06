//! Armar los comandos `input` del dispositivo: teclas por nombre y texto escapado.
//!
//! Puro: se prueba sin un teléfono.

/// El keycode de Android de una tecla nombrada como la nombraría una persona (`back`,
/// `enter`, `volume_up`), como `KEYCODE_…`, o por número.
pub fn keycode(name: &str) -> Option<u32> {
    let key = name.trim().to_lowercase().replace(['-', ' '], "_");
    let key = key.strip_prefix("keycode_").unwrap_or(&key);
    if let Ok(code) = key.parse::<u32>() {
        return Some(code);
    }
    let code = match key {
        "home" => 3,
        "back" => 4,
        "call" => 5,
        "endcall" => 6,
        "up" | "dpad_up" => 19,
        "down" | "dpad_down" => 20,
        "left" | "dpad_left" => 21,
        "right" | "dpad_right" => 22,
        "center" | "dpad_center" => 23,
        "volume_up" => 24,
        "volume_down" => 25,
        "power" => 26,
        "camera" => 27,
        "clear" => 28,
        "tab" => 61,
        "space" => 62,
        "enter" | "return" => 66,
        "backspace" | "del" | "delete" => 67,
        "menu" => 82,
        "notification" => 83,
        "search" => 84,
        "play_pause" | "media_play_pause" => 85,
        "page_up" => 92,
        "page_down" => 93,
        "escape" | "esc" => 111,
        "forward_del" | "forward_delete" => 112,
        "move_home" => 122,
        "move_end" => 123,
        "mute" | "volume_mute" => 164,
        "recents" | "app_switch" | "overview" => 187,
        "sleep" => 223,
        "wakeup" | "wake" => 224,
        "paste" => 279,
        "copy" => 278,
        "cut" => 277,
        _ => return None,
    };
    Some(code)
}

/// Un argumento entre comillas simples para el `sh` del teléfono.
pub fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

/// Un paso para escribir un texto: un tramo para `input text`, o una tecla.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeStep {
    Text(String),
    Key(u32),
}

/// Parte un texto en lo que `input text` puede escribir y las teclas que no.
///
/// `input text` no escribe saltos de línea ni tabs (los manda como letras raras), y los
/// espacios los toma como separadores salvo escritos `%s`. Un `%s` literal no se puede
/// escribir: se manda el `%` solo y después la `s`, en dos tramos.
pub fn type_steps(text: &str) -> Vec<TypeStep> {
    let mut steps = Vec::new();
    let mut chunk = String::new();
    let flush = |chunk: &mut String, steps: &mut Vec<TypeStep>| {
        if !chunk.is_empty() {
            steps.push(TypeStep::Text(std::mem::take(chunk)));
        }
    };
    for c in text.chars() {
        match c {
            '\n' => {
                flush(&mut chunk, &mut steps);
                steps.push(TypeStep::Key(66));
            }
            '\t' => {
                flush(&mut chunk, &mut steps);
                steps.push(TypeStep::Key(61));
            }
            '\r' => {}
            ' ' => chunk.push_str("%s"),
            's' if chunk.ends_with('%') && !chunk.ends_with("%s") => {
                flush(&mut chunk, &mut steps);
                chunk.push('s');
            }
            c => chunk.push(c),
        }
    }
    flush(&mut chunk, &mut steps);
    steps
}

/// Los caracteres que `input text` no puede escribir: todo lo que no es ASCII imprimible
/// (acentos, ñ, emojis). Android los rechaza o los cambia por otros.
pub fn untypeable(text: &str) -> Vec<char> {
    let mut out: Vec<char> = text.chars().filter(|c| !c.is_ascii() || (c.is_ascii_control() && !matches!(c, '\n' | '\t' | '\r'))).collect();
    out.dedup();
    out
}

/// De dónde a dónde arrastrar el dedo para desplazar en `direction`, dentro de `bounds`.
///
/// "Desplazar hacia abajo" es ver lo que hay más abajo: el dedo va de abajo hacia arriba.
/// Se deja un margen en los bordes para no tocar la barra de gestos ni la de notificaciones.
pub fn scroll_path(bounds: [i32; 4], direction: &str, amount: f64) -> Option<(i32, i32, i32, i32)> {
    let [l, t, r, b] = bounds;
    let (cx, cy) = ((l + r) / 2, (t + b) / 2);
    let amount = amount.clamp(0.1, 1.0);
    let half_h = (f64::from(b - t) * 0.4 * amount) as i32;
    let half_w = (f64::from(r - l) * 0.4 * amount) as i32;
    match direction.trim().to_lowercase().as_str() {
        "down" => Some((cx, cy + half_h, cx, cy - half_h)),
        "up" => Some((cx, cy - half_h, cx, cy + half_h)),
        "right" => Some((cx + half_w, cy, cx - half_w, cy)),
        "left" => Some((cx - half_w, cy, cx + half_w, cy)),
        _ => None,
    }
}
