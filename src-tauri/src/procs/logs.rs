//! Los logs de un subproceso, como los lee un agente: no todo el scrollback (llenaría su
//! contexto) sino lo que pide — lo nuevo desde su última lectura, las últimas líneas, lo
//! que coincide con un patrón, o solo los errores.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::orchestrator::digest::{self, Severity};

use super::{get, Status, Subprocess};

/// Las líneas que trae por defecto la cola de una lectura.
pub const DEFAULT_TAIL: usize = 40;
/// Tope de líneas que se devuelven de una vez, pidan lo que pidan.
const MAX_LINES: usize = 400;
/// Cuántas líneas de contexto acompañan a cada error.
const ERROR_CONTEXT: usize = 2;

lazy_static::lazy_static! {
    /// Hasta dónde leyó cada lector cada subproceso: `(lector, id) → total de bytes`. El
    /// lector es el agente (su tab o su tarea), así dos agentes no se pisan el "lo nuevo".
    static ref CURSORS: Mutex<HashMap<(String, String), u64>> = Mutex::new(HashMap::new());
}

fn cursors() -> std::sync::MutexGuard<'static, HashMap<(String, String), u64>> {
    CURSORS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hasta dónde leyó `reader` (0 si nunca leyó). Una espera por patrón mira desde acá: lo
/// que el agente todavía no leyó cuenta, aunque haya llegado antes de empezar a esperar
/// (le escribió algo y la respuesta salió enseguida).
pub fn cursor_of(reader: &str, id: &str) -> u64 {
    cursors().get(&(reader.to_string(), id.to_string())).copied().unwrap_or(0)
}

/// Al reiniciar, el PTY es otro y su cuenta de bytes vuelve a cero.
pub fn forget_cursors(id: &str) {
    cursors().retain(|(_, proc), _| proc != id);
}

/// El final de `text` que corresponde a sus últimos `bytes` bytes, en un borde de carácter.
fn last_bytes(text: &str, bytes: usize) -> &str {
    if bytes >= text.len() {
        return text;
    }
    let mut start = text.len() - bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Lo nuevo para `reader` desde su última lectura, y si se perdió algo en el medio (el
/// proceso escribió más de lo que entra en el scrollback). Con `advance`, mueve el cursor.
fn unread(reader: &str, id: &str, scrollback: &str, total: u64, advance: bool) -> (String, bool) {
    let key = (reader.to_string(), id.to_string());
    let seen = cursors().get(&key).copied().unwrap_or(0);
    if advance {
        cursors().insert(key, total);
    }
    let pending = total.saturating_sub(seen) as usize;
    let lost = pending > scrollback.len();
    (last_bytes(scrollback, pending).to_string(), lost)
}

/// Las líneas visibles (sin ANSI, sin ruido de redibujado) de un texto.
fn visible_lines(text: &str) -> Vec<String> {
    text.lines().map(digest::visible_line).filter(|l| !l.trim().is_empty()).collect()
}

fn tail(lines: &[String], n: usize) -> Vec<String> {
    lines[lines.len().saturating_sub(n.min(MAX_LINES))..].to_vec()
}

/// Cuántas líneas de error hay en lo que `reader` todavía no leyó, sin mover su cursor. Es
/// lo que deja a `process_list` decir "este tiene errores nuevos".
pub fn unread_errors(reader: &str, proc: &Subprocess) -> usize {
    let Some((scrollback, total)) = crate::terminal::scrollback_of(proc.pty_id) else { return 0 };
    let (text, _) = unread(reader, &proc.id, &scrollback, total, false);
    let lines = visible_lines(&text);
    tail(&lines, 2000).iter().filter(|l| digest::classify(l) == Some(Severity::Error)).count()
}

/// Qué quiere leer el agente.
#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Las últimas N líneas, aunque ya las haya leído.
    pub lines: Option<usize>,
    /// Solo las líneas que coinciden (regex, sin distinguir mayúsculas), de todo lo que hay.
    pub grep: Option<String>,
    /// Solo los errores y advertencias, con un poco de contexto.
    pub errors: bool,
}

/// Lee los logs de un subproceso para `reader` y devuelve el texto para el agente.
pub fn read(reader: &str, id: &str, query: &Query) -> Result<String, String> {
    let proc = get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
    let (scrollback, total) = crate::terminal::scrollback_of(proc.pty_id).unwrap_or_default();
    let header = status_line(&proc);

    // Cualquier lectura pone al día "lo nuevo": lo que el agente acaba de ver ya no es nuevo.
    let (new_text, lost) = unread(reader, id, &scrollback, total, true);

    if let Some(pattern) = &query.grep {
        let re = regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .map_err(|e| format!("patrón inválido: {e}"))?;
        let matches: Vec<String> = visible_lines(&scrollback).into_iter().filter(|l| re.is_match(l)).collect();
        let shown = tail(&matches, query.lines.unwrap_or(80));
        return Ok(format!(
            "{header}\n{} line(s) match /{pattern}/{}:\n{}",
            matches.len(),
            if shown.len() < matches.len() { format!(" (last {})", shown.len()) } else { String::new() },
            shown.join("\n")
        ));
    }

    if query.errors {
        let lines = visible_lines(&scrollback);
        let mut blocks: Vec<String> = Vec::new();
        let mut last_end = 0usize;
        for (i, line) in lines.iter().enumerate() {
            let Some(severity) = digest::classify(line) else { continue };
            let start = i.saturating_sub(ERROR_CONTEXT).max(last_end);
            let end = (i + ERROR_CONTEXT + 1).min(lines.len());
            let tag = if severity == Severity::Error { "error" } else { "warning" };
            blocks.push(format!("[{tag}] line {}:\n{}", i + 1, lines[start..end].join("\n")));
            last_end = end;
        }
        if blocks.is_empty() {
            return Ok(format!("{header}\nNo errors or warnings in the {} line(s) of output kept.", lines.len()));
        }
        let shown = &blocks[blocks.len().saturating_sub(20)..];
        return Ok(format!(
            "{header}\n{} error/warning spot(s){}:\n\n{}",
            blocks.len(),
            if shown.len() < blocks.len() { format!(" (last {})", shown.len()) } else { String::new() },
            shown.join("\n\n")
        ));
    }

    if let Some(n) = query.lines {
        let lines = visible_lines(&scrollback);
        let shown = tail(&lines, n);
        return Ok(format!("{header}\nLast {} line(s):\n{}", shown.len(), shown.join("\n")));
    }

    // Por defecto: lo nuevo desde la última lectura, resumido (errores aparte, la cola).
    if new_text.trim().is_empty() {
        return Ok(format!("{header}\nNo new output since your last read."));
    }
    let d = digest::digest(&new_text, DEFAULT_TAIL);
    let mut out = format!("{header}\n");
    if lost {
        out.push_str("(Older unread output was dropped: the process wrote more than the log keeps.)\n");
    }
    if !d.errors.is_empty() {
        out.push_str(&format!("Errors:\n{}\n", d.errors.join("\n")));
    }
    if !d.warnings.is_empty() {
        out.push_str(&format!("Warnings:\n{}\n", d.warnings.join("\n")));
    }
    out.push_str(&format!(
        "New output ({} line(s){}):\n{}",
        d.kept_lines,
        if d.kept_lines > d.tail.len() { format!(", last {}", d.tail.len()) } else { String::new() },
        d.tail.join("\n")
    ));
    Ok(out)
}

/// Una línea con el estado, para encabezar lo que se le devuelve al agente.
pub fn status_line(proc: &Subprocess) -> String {
    let state = match proc.status {
        Status::Running => "running".to_string(),
        Status::Exited => format!("exited with code {}", proc.exit_code.unwrap_or(0)),
        Status::Stopped => "stopped".to_string(),
    };
    format!("[{}] {} — {} (in {})", proc.id, proc.command, state, proc.cwd)
}

/// Hasta qué esperar.
#[derive(Debug, Clone)]
pub enum Until {
    /// Que termine.
    Exit,
    /// Que aparezca algo que coincida (regex, sin distinguir mayúsculas) en lo que escriba
    /// desde ahora. También vuelve si el proceso termina antes.
    Pattern(regex::Regex),
    /// Que se quede callado este tiempo: terminó de compilar, el servidor ya levantó.
    Idle(Duration),
}

/// Cómo terminó una espera.
#[derive(Debug, PartialEq)]
pub enum Waited {
    Matched(String),
    Exited,
    Idle,
    TimedOut,
    Cancelled,
}

/// Espera a lo que diga `until`, con tope `timeout`. `from` es desde qué total de bytes
/// mirar (para un patrón: no vale lo que ya estaba escrito antes de empezar a esperar).
pub fn wait(id: &str, until: &Until, timeout: Duration, from: Option<u64>, cancelled: &dyn Fn() -> bool) -> Result<Waited, String> {
    const POLL: Duration = Duration::from_millis(150);
    let deadline = Instant::now() + timeout;
    let start_proc = get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
    let pty = start_proc.pty_id;
    let start_total = from.unwrap_or_else(|| crate::terminal::output_total(pty).unwrap_or(0));
    let mut last_total = crate::terminal::output_total(pty).unwrap_or(0);
    let mut quiet_since = Instant::now();

    loop {
        if cancelled() {
            return Ok(Waited::Cancelled);
        }
        let proc = get(id).ok_or_else(|| format!("no hay ningún subproceso {id}"))?;
        if let Until::Pattern(re) = until
            && let Some((scrollback, total)) = crate::terminal::scrollback_of(pty)
        {
            let fresh = last_bytes(&scrollback, total.saturating_sub(start_total) as usize);
            if let Some(line) = visible_lines(fresh).into_iter().find(|l| re.is_match(l)) {
                return Ok(Waited::Matched(line));
            }
        }
        if proc.status != Status::Running || proc.pty_id != pty {
            return Ok(Waited::Exited);
        }
        let total = crate::terminal::output_total(pty).unwrap_or(0);
        if total != last_total {
            last_total = total;
            quiet_since = Instant::now();
        } else if let Until::Idle(quiet) = until
            && quiet_since.elapsed() >= *quiet
        {
            return Ok(Waited::Idle);
        }
        if Instant::now() >= deadline {
            return Ok(Waited::TimedOut);
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
pub(crate) fn last_bytes_for_tests(text: &str, bytes: usize) -> &str {
    last_bytes(text, bytes)
}
