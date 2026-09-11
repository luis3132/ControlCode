//! Qué se decide sin preguntar.
//!
//! Con un agente solo, contestar cada permiso a mano se banca. Con cinco es inusable: la
//! consola se llena de preguntas y el usuario termina apretando "sí" a todo, que es peor
//! que no haber preguntado. Las reglas son lo que deja que la consola muestre **solo lo
//! que ninguna cubre**.
//!
//! Todo acá es puro: una regla es texto, un pedido es un nombre de herramienta más su
//! input, y la decisión sale de compararlos. Se puede probar sin lanzar nada.
//!
//! ## La forma de una regla
//!
//! `Herramienta` o `Herramienta(patrón)`, la misma que ya usa Claude Code en
//! `--allowedTools`. Se eligió esa y no una propia porque es la que el usuario ya tiene
//! escrita en sus `settings.json`, y tener dos sintaxis para lo mismo es una garantía de
//! que se van a confundir.
//!
//! - `Read` — cualquier lectura.
//! - `Bash(git status*)` — solo ese comando.
//! - `Edit(src/**)` — solo dentro de esa carpeta.
//!
//! El `patrón` se compara contra **el mismo campo que identifica la acción** en la
//! tarjeta: la ruta para las de archivo, el comando para `Bash`, el patrón para las de
//! búsqueda. Que sea el mismo importa: una regla que se aplica a algo distinto de lo que
//! el usuario leyó en la tarjeta es una trampa.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    /// `Bash(git status*)`, `Read`, `Edit(src/**)`.
    pub pattern: String,
    /// `true` = permitir sin preguntar, `false` = denegar sin preguntar.
    pub allow: bool,
}

/// Qué hacer con un pedido.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Decision {
    Allow,
    Deny,
    /// Ninguna regla lo cubre: va a la consola y espera a una persona.
    Ask,
}

/// El argumento de una herramienta que una regla puede mirar.
///
/// Es el mismo que muestra `activity::tool_label`, a propósito: la regla se escribe
/// mirando la tarjeta.
pub fn rule_arg(tool: &str, input: &serde_json::Value) -> Option<String> {
    let key = match tool {
        "Read" | "Edit" | "Write" | "NotebookEdit" => "file_path",
        "Bash" | "BashOutput" => "command",
        "Grep" | "Glob" => "pattern",
        "WebFetch" => "url",
        _ => return None,
    };
    input.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Parte una regla en `(herramienta, patrón)`.
fn split(pattern: &str) -> (&str, Option<&str>) {
    let p = pattern.trim();
    match (p.find('('), p.strip_suffix(')')) {
        (Some(i), Some(_)) => (p[..i].trim(), Some(&p[i + 1..p.len() - 1])),
        _ => (p, None),
    }
}

/// Un glob con `*` (cualquier cosa, barras incluidas) y `**` (lo mismo).
///
/// `**` no se distingue de `*` porque la diferencia solo importa cuando se quiere que `*`
/// NO cruce barras, y acá la comparación es contra una ruta o un comando enteros: hacer
/// que `src/*` no matchee `src/a/b.rs` sorprendería más de lo que ayudaría. Se acepta
/// `**` igual porque es lo que el usuario ya escribe en sus settings.
fn glob_matches(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').filter(|p| !p.is_empty()).collect();
    if !pattern.contains('*') {
        return pattern == text;
    }

    let mut rest = text;
    // Un patrón que no arranca con `*` tiene que anclarse al principio.
    if let Some(first) = parts.first() {
        if !pattern.starts_with('*') {
            let Some(stripped) = rest.strip_prefix(first) else { return false };
            rest = stripped;
        }
    }
    let skip_first = usize::from(!pattern.starts_with('*'));
    for part in parts.iter().skip(skip_first) {
        let Some(i) = rest.find(part) else { return false };
        rest = &rest[i + part.len()..];
    }
    // Y uno que no termina en `*` tiene que llegar hasta el final.
    pattern.ends_with('*') || rest.is_empty()
}

fn rule_matches(rule: &PermissionRule, tool: &str, arg: Option<&str>) -> bool {
    let (rule_tool, rule_arg) = split(&rule.pattern);
    if rule_tool != tool {
        return false;
    }
    match rule_arg {
        // Sin paréntesis la regla vale para toda la herramienta.
        None => true,
        // Con paréntesis hace falta un argumento que comparar: si la herramienta no expone
        // ninguno que conozcamos, la regla NO aplica y se termina preguntando. Es el lado
        // seguro del error — el otro sería permitir algo por una regla que nunca se pudo
        // verificar.
        Some(pat) => arg.is_some_and(|a| glob_matches(pat, a)),
    }
}

/// Qué dicen las reglas sobre este pedido.
///
/// Gana **la primera que coincide**, no la más específica. El orden es el que el usuario
/// ve y puede reordenar; inferir precedencia por especificidad haría que dos reglas que se
/// leen claras produzcan un resultado que no se deduce mirándolas.
pub fn decide(rules: &[PermissionRule], tool: &str, input: &serde_json::Value) -> Decision {
    let arg = rule_arg(tool, input);
    match rules.iter().find(|r| rule_matches(r, tool, arg.as_deref())) {
        Some(r) if r.allow => Decision::Allow,
        Some(_) => Decision::Deny,
        None => Decision::Ask,
    }
}

/// Las reglas de un run, tal como se guardan en su columna.
pub fn parse_rules(json: &str) -> Vec<PermissionRule> {
    // Una columna ilegible no puede dejar a un agente sin supervisión: sin reglas se
    // pregunta todo, que es el lado seguro.
    serde_json::from_str(json).unwrap_or_default()
}
