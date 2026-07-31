//! Exportación de una sesión archivada a markdown.
//!
//! El export tiene dos partes independientes: la metadata (que siempre sale, porque la
//! tiene la app) y la transcripción de la conversación (que sale de leer el archivo de
//! sesión del agente y puede no estar disponible: la sesión pudo no resolver nunca su id,
//! o el CLI pudo haber borrado/rotado su historial). Cuando la transcripción no se puede
//! leer, se exporta igual con la metadata y una nota explicando por qué falta — es más
//! útil que fallar.

use crate::database::{ArchivedSkill, DbConnection, SessionHistoryEntry, SiblingTab};
use serde_json::Value;
use std::fmt::Write as _;
use std::path::Path;

/// Un turno de la conversación, ya normalizado.
struct Turn {
    role: String,
    text: String,
}

/// Rol declarado en una línea del JSONL, mirando las formas que usan los CLIs soportados:
/// `{"role": "user"}` plano, o anidado bajo `message`/`payload`.
fn role_of(v: &Value) -> Option<String> {
    for path in [vec!["role"], vec!["message", "role"], vec!["payload", "role"]] {
        if let Some(found) = dig(v, &path).and_then(|c| c.as_str()) {
            return Some(found.to_string());
        }
    }
    None
}

/// Camina una ruta de claves anidadas. Devuelve `None` si la ruta no existe — sin
/// abortar la búsqueda de las OTRAS rutas que prueban los llamadores.
fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    Some(cur)
}

/// Texto de un bloque `content`, que según el agente es un string plano o un array de
/// bloques tipados (`text`, `input_text`, `output_text`).
fn text_of_content(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    let blocks = content.as_array()?;
    let joined: Vec<String> = blocks
        .iter()
        .filter_map(|b| {
            let kind = b.get("type").and_then(|t| t.as_str())?;
            if kind == "text" || kind == "input_text" || kind == "output_text" {
                b.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .filter(|s| !s.is_empty())
        .collect();
    (!joined.is_empty()).then(|| joined.join("\n\n"))
}

fn content_of(v: &Value) -> Option<String> {
    for path in [vec!["content"], vec!["message", "content"], vec!["payload", "content"]] {
        if let Some(text) = dig(v, &path).and_then(text_of_content) {
            return Some(text);
        }
    }
    None
}

/// Lee un archivo de sesión JSONL y devuelve los turnos de usuario y asistente en orden.
/// Las líneas que no son mensajes (metadata, tool calls, deltas de streaming sin texto)
/// se saltean solas al no tener rol + contenido textual.
fn extract_transcript(path: &Path) -> Vec<Turn> {
    let Ok(content) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut turns: Vec<Turn> = Vec::new();

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(role) = role_of(&v) else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(text) = content_of(&v) else { continue };

        // Los CLIs que emiten el mensaje en trozos (streaming) generan varias líneas con
        // el mismo rol; se concatenan en un solo turno en vez de repetir el encabezado.
        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => turns.push(Turn { role, text }),
        }
    }
    turns
}

/// Transcripción de una sesión de OpenCode, pedida a su propia CLI.
///
/// OpenCode no deja un archivo de sesión legible como el resto de los agentes, así que no
/// hay nada que pasarle a `extract_transcript`. Lo que sí tiene es `opencode export <id>`,
/// que escribe la sesión entera como JSON en stdout (el banner informativo va a stderr).
///
/// Formato verificado contra la v1.18.4: `{ "info": {...}, "messages": [ { "info": {
/// "role": … }, "parts": [ { "type": "text", "text": … } ] } ] }`. Solo interesan las
/// partes de tipo `text`: el resto son pasos internos (`step-start`, `reasoning`, `tool`,
/// `patch`) que no forman parte de la conversación que el usuario quiere exportar.
fn opencode_transcript(session_id: &str) -> Vec<Turn> {
    let Ok(output) = std::process::Command::new("opencode")
        .args(["export", session_id])
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_opencode_export(&output.stdout)
}

/// Parseo puro del JSON que emite `opencode export`, separado del proceso para poder
/// testearlo contra una muestra real sin depender de que OpenCode esté instalado.
fn parse_opencode_export(json: &[u8]) -> Vec<Turn> {
    let Ok(root) = serde_json::from_slice::<Value>(json) else { return Vec::new() };
    let Some(messages) = root.get("messages").and_then(|m| m.as_array()) else {
        return Vec::new();
    };

    let mut turns: Vec<Turn> = Vec::new();
    for message in messages {
        let Some(role) = dig(message, &["info", "role"]).and_then(|r| r.as_str()) else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = message
            .get("parts")
            .and_then(|p| p.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .filter(|t| !t.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }

        // Un turno del asistente puede venir partido en varios mensajes (un "step" por
        // llamada a herramienta); se juntan igual que en `extract_transcript`.
        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => turns.push(Turn { role: role.to_string(), text }),
        }
    }
    turns
}

fn format_ts(unix_seconds: i64) -> String {
    // Sin dependencia de fechas en el backend: se emite ISO-8601 en UTC a mano, que es
    // inequívoco y ordenable. La UI ya muestra la fecha localizada por su cuenta.
    let days_since_epoch = unix_seconds.div_euclid(86_400);
    let secs_of_day = unix_seconds.rem_euclid(86_400);

    // Algoritmo civil-from-days (Howard Hinnant), válido para todo el rango proléptico.
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

fn render_skills(skills: &[ArchivedSkill]) -> String {
    if skills.is_empty() {
        return "_Ninguna_".to_string();
    }
    skills
        .iter()
        .map(|s| format!("`{}` ({})", s.name, s.scope))
        .collect::<Vec<_>>()
        .join(", ")
}

fn render_siblings(siblings: &[SiblingTab]) -> String {
    if siblings.is_empty() {
        return "_Era la única tab abierta_\n".to_string();
    }
    let mut out = String::new();
    for s in siblings {
        let _ = writeln!(
            out,
            "- {} — `{}` en `{}`",
            s.title.as_deref().unwrap_or("(sin título)"),
            s.agent_label,
            s.cwd
        );
    }
    out
}

fn render(entry: &SessionHistoryEntry, workspace: Option<&str>, transcript: &[Turn]) -> String {
    let mut out = String::new();

    let _ = writeln!(out, "# {}", entry.title.as_deref().unwrap_or(&entry.agent_label));
    let _ = writeln!(out);
    let _ = writeln!(out, "| | |");
    let _ = writeln!(out, "|---|---|");
    let _ = writeln!(out, "| Agente | {} (`{}`) |", entry.agent_label, entry.command);
    let _ = writeln!(out, "| Carpeta | `{}` |", entry.cwd);
    if let Some(ws) = workspace {
        let _ = writeln!(out, "| Workspace | {ws} |");
    }
    let _ = writeln!(out, "| Abierta | {} |", format_ts(entry.opened_at));
    let _ = writeln!(out, "| Cerrada | {} |", format_ts(entry.closed_at));
    if let Some(sid) = &entry.session_id {
        let _ = writeln!(out, "| Id de sesión | `{sid}` |");
    }
    let _ = writeln!(out, "| Skills | {} |", render_skills(&entry.skills));
    let _ = writeln!(out);

    let _ = writeln!(out, "## Tabs abiertas junto a esta");
    let _ = writeln!(out);
    let _ = write!(out, "{}", render_siblings(&entry.sibling_tabs));
    let _ = writeln!(out);

    let _ = writeln!(out, "## Conversación");
    let _ = writeln!(out);
    if transcript.is_empty() {
        let _ = writeln!(
            out,
            "_No se pudo leer la conversación de esta sesión: puede que el agente no haya \
             dejado un archivo de sesión legible, o que ya lo haya borrado._"
        );
    } else {
        for turn in transcript {
            let who = if turn.role == "user" { "Usuario" } else { &entry.agent_label };
            let _ = writeln!(out, "### {who}");
            let _ = writeln!(out);
            let _ = writeln!(out, "{}", turn.text);
            let _ = writeln!(out);
        }
    }

    out
}

/// Genera el markdown de una sesión archivada. Se expone aparte de `export_session_markdown`
/// para poder previsualizarlo sin escribir a disco.
#[tauri::command]
pub fn session_markdown(
    history_id: String,
    db: tauri::State<DbConnection>,
) -> Result<String, String> {
    let (entry, workspace) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let entry = crate::database::session_history_entry(&conn, &history_id)?
            .ok_or_else(|| "Esta sesión ya no está en el historial".to_string())?;
        let workspace = crate::database::workspace_name(&conn, &entry.workspace_id);
        (entry, workspace)
    };

    // El lock se suelta antes de tocar el filesystem: buscar y leer el archivo de sesión
    // puede recorrer un árbol grande, y no hay motivo para bloquear la DB mientras tanto.
    //
    // OpenCode va por otro camino porque no deja un archivo de sesión que se pueda leer: su
    // transcripción se pide con `opencode export <id>` (ver `opencode_transcript`). Sin
    // `session_id` no hay nada que exportar — a diferencia del resto, acá no existe un
    // "archivo más reciente del cwd" al que caer.
    let transcript = if entry.agent_id == "opencode" {
        entry.session_id.as_deref().map(opencode_transcript).unwrap_or_default()
    } else {
        super::title::session_file_for(
            &entry.agent_id,
            &entry.cwd,
            entry.session_id.as_deref(),
            &db,
        )
        .map(|path| extract_transcript(&path))
        .unwrap_or_default()
    };

    Ok(render(&entry, workspace.as_deref(), &transcript))
}

#[tauri::command]
pub fn export_session_markdown(
    history_id: String,
    dest_path: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let markdown = session_markdown(history_id, db)?;
    std::fs::write(&dest_path, markdown).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Muestra recortada de `opencode export` real (v1.18.4): la conversación vive en
    /// `messages[].parts[]`, y solo las partes `text` son conversación — `step-start`,
    /// `reasoning`, `tool` y `patch` son pasos internos que no van al markdown.
    const OPENCODE_EXPORT: &str = r#"{
      "info": { "id": "ses_1", "title": "Refactor del parser" },
      "messages": [
        { "info": { "role": "user" },
          "parts": [ { "type": "text", "text": "arregla el parser" },
                     { "type": "file", "filename": "a.rs" } ] },
        { "info": { "role": "assistant" },
          "parts": [ { "type": "step-start" }, { "type": "reasoning", "text": "pensando" },
                     { "type": "tool", "tool": "edit" }, { "type": "step-finish" } ] },
        { "info": { "role": "assistant" },
          "parts": [ { "type": "text", "text": "Listo, cambié el lexer." },
                     { "type": "patch" } ] }
      ]
    }"#;

    #[test]
    fn opencode_export_keeps_only_the_conversation() {
        let turns = parse_opencode_export(OPENCODE_EXPORT.as_bytes());

        // El mensaje del medio es puro paso interno (sin ninguna parte `text`) y no genera
        // un turno vacío; el siguiente del asistente sí, y no se fusiona con nada previo
        // porque en el medio no quedó ningún turno de assistant.
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].text, "arregla el parser");
        assert_eq!(turns[1].role, "assistant");
        assert_eq!(turns[1].text, "Listo, cambié el lexer.");
    }

    #[test]
    fn opencode_export_survives_garbage() {
        // Una instalación rota o una versión que cambie el formato devuelve vacío en vez de
        // reventar: el export igual se genera, solo que sin transcripción.
        assert!(parse_opencode_export(b"no soy json").is_empty());
        assert!(parse_opencode_export(b"{}").is_empty());
        assert!(parse_opencode_export(br#"{"messages":[]}"#).is_empty());
    }

    #[test]
    fn transcript_reads_the_shapes_the_supported_clis_emit() {
        let dir = std::env::temp_dir().join(format!("cc-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                // Claude Code: mensaje anidado bajo `message`, contenido como bloques.
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hola"}]}}"#, "\n",
                // Línea de metadata sin rol: se saltea.
                r#"{"type":"summary","summary":"algo"}"#, "\n",
                // Codex: rol plano, contenido string.
                r#"{"role":"assistant","content":"respuesta"}"#, "\n",
                // Streaming: dos líneas del mismo rol se unen en un turno.
                r#"{"role":"assistant","content":"continuada"}"#, "\n",
                // Rol que no interesa (tool): se saltea.
                r#"{"role":"tool","content":"salida de herramienta"}"#, "\n",
                // JSON inválido: se saltea sin romper.
                "no es json", "\n",
            ),
        ).unwrap();

        let turns = extract_transcript(&path);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].text, "hola");
        assert_eq!(turns[1].role, "assistant");
        assert_eq!(turns[1].text, "respuesta\n\ncontinuada");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_render_as_utc_iso() {
        assert_eq!(format_ts(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_ts(1_700_000_000), "2023-11-14 22:13:20 UTC");
    }

    /// Sin transcripción legible el export no falla: sale la metadata y una nota.
    #[test]
    fn render_without_transcript_still_documents_the_session() {
        let entry = SessionHistoryEntry {
            id: "h1".into(),
            workspace_id: "ws".into(),
            agent_id: "claude-code".into(),
            agent_label: "Claude Code".into(),
            command: "claude".into(),
            cwd: "/proj".into(),
            title: Some("Mi sesión".into()),
            session_id: None,
            skills: vec![ArchivedSkill {
                id: "s1".into(),
                name: "git-helper".into(),
                scope: "tab".into(),
            }],
            sibling_tabs: vec![SiblingTab {
                title: Some("Otra".into()),
                agent_label: "Gemini CLI".into(),
                cwd: "/proj/web".into(),
            }],
            opened_at: 0,
            closed_at: 60,
        };

        let md = render(&entry, Some("Mi WS"), &[]);
        assert!(md.starts_with("# Mi sesión"));
        assert!(md.contains("`git-helper` (tab)"));
        assert!(md.contains("Gemini CLI"));
        assert!(md.contains("No se pudo leer la conversación"));
    }
}
