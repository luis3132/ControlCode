//! Leer la pantalla por accesibilidad: `uiautomator dump` convertido en algo que un agente
//! pueda leer y usar.
//!
//! El XML crudo de una pantalla común son decenas de KB de contenedores sin nada. De acá
//! sale una línea por elemento que importa —tiene texto, una descripción, un id, o se puede
//! tocar, escribir o desplazar—, con un ref (`a12`) para actuar sobre él y su centro en
//! píxeles del dispositivo, por si el agente prefiere tocar por coordenadas.

use regex::Regex;
use std::sync::OnceLock;

/// Un elemento de la pantalla, como lo describe uiautomator.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UiNode {
    /// Cuántos `node` lo contienen.
    pub depth: usize,
    pub class: String,
    pub package: String,
    pub text: String,
    /// `content-desc`: lo que lee TalkBack. En íconos suele ser lo único que dice qué son.
    pub desc: String,
    /// `resource-id` sin el paquete (`login_button` y no `com.app:id/login_button`).
    pub id: String,
    /// `[izquierda, arriba, derecha, abajo]` en píxeles del dispositivo.
    pub bounds: [i32; 4],
    pub clickable: bool,
    pub long_clickable: bool,
    pub scrollable: bool,
    pub checkable: bool,
    pub checked: bool,
    pub enabled: bool,
    pub focused: bool,
    pub selected: bool,
    pub password: bool,
    pub editable: bool,
}

impl UiNode {
    pub fn center(&self) -> (i32, i32) {
        ((self.bounds[0] + self.bounds[2]) / 2, (self.bounds[1] + self.bounds[3]) / 2)
    }

    fn area(&self) -> i64 {
        i64::from((self.bounds[2] - self.bounds[0]).max(0)) * i64::from((self.bounds[3] - self.bounds[1]).max(0))
    }

    /// Si vale la pena mostrarlo: dice algo o se puede usar.
    fn meaningful(&self) -> bool {
        self.area() > 0
            && (!self.text.is_empty()
                || !self.desc.is_empty()
                || self.clickable
                || self.long_clickable
                || self.scrollable
                || self.checkable
                || self.editable)
    }

    /// El nombre corto de la clase: `Button` y no `android.widget.Button`.
    fn kind(&self) -> &str {
        self.class.rsplit('.').next().unwrap_or(&self.class)
    }
}

fn attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"([\w:-]+)="([^"]*)""#).expect("regex de atributos"))
}

fn bounds_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]").expect("regex de bounds"))
}

/// Las entidades que escribe uiautomator en los valores.
fn unescape(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Lee el XML de `uiautomator dump`. Es XML generado por máquina, siempre con la misma
/// forma (`<node …>` / `<node …/>` / `</node>`), así que alcanza con recorrer sus etiquetas.
pub fn parse(xml: &str) -> Result<Vec<UiNode>, String> {
    if !xml.contains("<hierarchy") {
        let hint = xml.trim();
        return Err(if hint.is_empty() {
            "uiautomator returned nothing.".into()
        } else {
            format!("uiautomator did not return a screen: {}", hint.chars().take(300).collect::<String>())
        });
    }
    let mut nodes = Vec::new();
    let mut depth = 0usize;
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        let tail = &rest[start..];
        let Some(end) = tail.find('>') else { break };
        let tag = &tail[1..end];
        rest = &tail[end + 1..];
        if tag.starts_with("/node") {
            depth = depth.saturating_sub(1);
            continue;
        }
        if !tag.starts_with("node") {
            continue;
        }
        let self_closing = tag.ends_with('/');
        let mut node = UiNode { depth, enabled: true, ..UiNode::default() };
        for cap in attr_re().captures_iter(tag) {
            let value = &cap[2];
            let yes = value == "true";
            match &cap[1] {
                "text" => node.text = unescape(value),
                "content-desc" => node.desc = unescape(value),
                "class" => node.class = value.to_string(),
                "package" => node.package = value.to_string(),
                "resource-id" => node.id = value.rsplit('/').next().unwrap_or(value).to_string(),
                "clickable" => node.clickable = yes,
                "long-clickable" => node.long_clickable = yes,
                "scrollable" => node.scrollable = yes,
                "checkable" => node.checkable = yes,
                "checked" => node.checked = yes,
                "enabled" => node.enabled = yes,
                "focused" => node.focused = yes,
                "selected" => node.selected = yes,
                "password" => node.password = yes,
                "bounds" => {
                    if let Some(b) = bounds_re().captures(value) {
                        let n = |i: usize| b[i].parse::<i32>().unwrap_or(0);
                        node.bounds = [n(1), n(2), n(3), n(4)];
                    }
                }
                _ => {}
            }
        }
        node.editable = node.class.contains("EditText") || node.class.contains("AutoCompleteTextView");
        nodes.push(node);
        if !self_closing {
            depth += 1;
        }
    }
    Ok(nodes)
}

/// Un elemento con ref, tal como quedó en el último snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub reference: String,
    pub bounds: [i32; 4],
    pub label: String,
}

fn clip(text: &str, max: usize) -> String {
    let flat = text.replace('\n', " ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

/// El texto que lo nombra. Un contenedor tocable sin texto propio (la fila de una lista, un
/// botón hecho de un ícono y una etiqueta) se nombra con el de lo que tiene adentro.
fn label_of(nodes: &[UiNode], index: usize) -> String {
    let node = &nodes[index];
    if !node.text.is_empty() {
        return node.text.clone();
    }
    if !node.desc.is_empty() {
        return node.desc.clone();
    }
    let mut inner = Vec::new();
    for child in nodes[index + 1..].iter().take_while(|n| n.depth > node.depth) {
        let text = if child.text.is_empty() { &child.desc } else { &child.text };
        if !text.is_empty() && !inner.contains(text) {
            inner.push(text.clone());
            if inner.len() == 3 {
                break;
            }
        }
    }
    inner.join(" · ")
}

/// El snapshot en texto y los refs que nombra.
///
/// Una línea por elemento, sangrada por cuántos elementos mostrados lo contienen:
/// `[a7] Button "Iniciar sesión" #login clickable @540,1630`.
pub fn render(nodes: &[UiNode]) -> (String, Vec<Target>) {
    let mut lines = Vec::new();
    let mut targets = Vec::new();
    // La profundidad de los mostrados que contienen al actual, para sangrar.
    let mut open: Vec<usize> = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        while open.last().is_some_and(|d| *d >= node.depth) {
            open.pop();
        }
        if !node.meaningful() {
            continue;
        }
        let reference = format!("a{}", targets.len() + 1);
        let label = label_of(nodes, index);
        let mut line = format!("{}[{reference}] {}", "  ".repeat(open.len()), node.kind());
        if !label.is_empty() {
            let own = !node.text.is_empty() || !node.desc.is_empty();
            line.push_str(&format!(" {}\"{}\"", if own { "" } else { "≈" }, clip(&label, 80)));
        }
        if !node.text.is_empty() && !node.desc.is_empty() && node.desc != node.text {
            line.push_str(&format!(" desc=\"{}\"", clip(&node.desc, 60)));
        }
        if !node.id.is_empty() {
            line.push_str(&format!(" #{}", node.id));
        }
        let flags = [
            (node.editable, "editable"),
            (node.password, "password"),
            (node.clickable && !node.editable, "clickable"),
            (node.long_clickable, "long-clickable"),
            (node.scrollable, "scrollable"),
            (node.checkable && node.checked, "checked"),
            (node.checkable && !node.checked, "unchecked"),
            (node.selected, "selected"),
            (node.focused, "focused"),
            (!node.enabled, "disabled"),
        ];
        for (on, flag) in flags {
            if on {
                line.push(' ');
                line.push_str(flag);
            }
        }
        let (x, y) = node.center();
        line.push_str(&format!(" @{x},{y}"));
        lines.push(line);
        targets.push(Target { reference, bounds: node.bounds, label });
        open.push(node.depth);
    }
    (lines.join("\n"), targets)
}

/// El elemento que mejor coincide con `wanted`: primero el texto o la descripción exactos,
/// después que los contenga; entre varios, el tocable y el más chico (el más específico).
pub fn find_text<'a>(nodes: &'a [UiNode], wanted: &str) -> Option<&'a UiNode> {
    let exact = wanted.trim();
    let wanted = exact.to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let score = |n: &UiNode| -> Option<u8> {
        if n.area() == 0 {
            return None;
        }
        let text = n.text.to_lowercase();
        let desc = n.desc.to_lowercase();
        let id = n.id.to_lowercase();
        // Tal cual primero: "Display" es el título de la opción, "display" lo que alguien
        // escribió en el buscador.
        if n.text == exact || n.desc == exact {
            Some(0)
        } else if text == wanted || desc == wanted {
            Some(1)
        } else if id == wanted {
            Some(2)
        } else if text.contains(&wanted) || desc.contains(&wanted) {
            Some(3)
        } else {
            None
        }
    };
    nodes
        .iter()
        .filter_map(|n| score(n).map(|s| (s, n)))
        .min_by_key(|(s, n)| (*s, !(n.clickable || n.editable), n.area()))
        .map(|(_, n)| n)
}

/// El paquete en primer plano, según los nodos (el que más ocupa la pantalla).
pub fn foreground_package(nodes: &[UiNode]) -> Option<&str> {
    nodes.iter().filter(|n| !n.package.is_empty()).max_by_key(|n| n.area()).map(|n| n.package.as_str())
}
