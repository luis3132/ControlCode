//! Correr `ssh` y `scp` de verdad.
//!
//! Siempre con tope de tiempo (`util::output_with_timeout`): un equipo que dejó de
//! contestar a mitad de camino no puede dejar a un agente, ni a la UI, esperando para
//! siempre.

use std::process::Command;
use std::time::{Duration, Instant};

use super::args::{exec_args, hint_for, scp_args, terminal_command};
use super::model::{ConnectionCheck, RemoteOutput, SshConnection, SshConnectionDraft, TerminalLaunch};
use crate::database::DbConnection;
use crate::util::output_with_timeout;

/// Cuánto de cada salida se devuelve. Más que esto se come el contexto de un agente, y
/// lo que suele importar de un comando largo es el final.
pub const MAX_OUTPUT_CHARS: usize = 30_000;

/// Se queda con el FINAL del texto, sin cortar un carácter por la mitad.
pub fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[… {} bytes anteriores recortados]\n{}", start, &text[start..])
}

fn spawn_error(program: &str, e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "No se encontró `{program}` en esta computadora. Instalá el cliente de OpenSSH."
        ),
        std::io::ErrorKind::TimedOut => format!("{program}: {e}"),
        _ => format!("No se pudo ejecutar `{program}`: {e}"),
    }
}

fn run_program(program: &str, args: &[String], limit: Duration) -> Result<RemoteOutput, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    let out = output_with_timeout(&mut cmd, limit).map_err(|e| spawn_error(program, e))?;
    Ok(RemoteOutput {
        exit_code: out.status.code(),
        stdout: tail(&String::from_utf8_lossy(&out.stdout), MAX_OUTPUT_CHARS),
        stderr: tail(&String::from_utf8_lossy(&out.stderr), MAX_OUTPUT_CHARS),
    })
}

/// Corre `command` en esa computadora (en `cwd`, o en su carpeta por defecto).
pub fn run_remote(
    c: &SshConnection,
    command: &str,
    cwd: Option<&str>,
    limit: Duration,
) -> Result<RemoteOutput, String> {
    run_program("ssh", &exec_args(c, command, cwd), limit)
}

/// Copia con `scp`. `from`/`to` ya vienen armados (uno local, otro `equipo:ruta`).
///
/// El `scp` de OpenSSH 9 copia por SFTP, y hay servidores sin ese subsistema (imágenes
/// mínimas, routers, un `sshd_config` armado a mano). Ahí se reintenta con el protocolo
/// viejo (`-O`) en vez de fallar: un `scp` anterior al 9 ya usaba ese y nunca llega acá.
pub fn copy(c: &SshConnection, from: &str, to: &str, recursive: bool, limit: Duration) -> Result<RemoteOutput, String> {
    let args = scp_args(c, from, to, recursive);
    let out = run_program("scp", &args, limit)?;
    if out.exit_code != Some(0) && out.stderr.contains("subsystem request failed") {
        let legacy: Vec<String> = std::iter::once("-O".to_string()).chain(args).collect();
        return run_program("scp", &legacy, limit);
    }
    Ok(out)
}

/// Lo que responde el otro lado a la prueba: prueba que el comando llegó y volvió.
const PROBE: &str = "echo controlcode-ok";

/// Prueba una conexión igual que la van a usar los agentes: sin interacción.
pub fn check(c: &SshConnection) -> ConnectionCheck {
    let started = Instant::now();
    let limit = Duration::from_secs(super::args::CONNECT_TIMEOUT_SECS + 10);
    // Sin la carpeta: la prueba es de la conexión, y una carpeta mal escrita tiene su
    // propio mensaje más abajo.
    let bare = SshConnection { remote_dir: None, ..c.clone() };
    let result = run_remote(&bare, PROBE, None, limit);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let out = match result {
        Ok(out) => out,
        Err(e) => return ConnectionCheck { ok: false, detail: e, hint: None, elapsed_ms },
    };
    if out.exit_code != Some(0) || !out.stdout.contains("controlcode-ok") {
        let detail = out.stderr.trim().to_string();
        return ConnectionCheck {
            ok: false,
            hint: hint_for(&detail).map(str::to_string),
            detail: if detail.is_empty() { format!("ssh terminó con código {:?}", out.exit_code) } else { detail },
            elapsed_ms,
        };
    }
    if let Some(dir) = &c.remote_dir {
        let cd = run_remote(c, "true", None, limit);
        if !matches!(&cd, Ok(o) if o.exit_code == Some(0)) {
            return ConnectionCheck {
                ok: false,
                detail: format!("Conecta, pero la carpeta '{dir}' no existe allá (o no se puede entrar)."),
                hint: None,
                elapsed_ms,
            };
        }
    }
    ConnectionCheck { ok: true, detail: "Conectado".into(), hint: None, elapsed_ms }
}

/// "Probar" del formulario: prueba lo que está escrito, guardado o no.
#[tauri::command]
pub async fn test_ssh_connection(draft: SshConnectionDraft) -> Result<ConnectionCheck, String> {
    let c = super::args::connection_from_draft(draft)?;
    tauri::async_runtime::spawn_blocking(move || check(&c)).await.map_err(|e| e.to_string())
}

/// El comando para una tab de terminal en esa computadora.
#[tauri::command]
pub fn ssh_terminal_command(id: String, db: tauri::State<DbConnection>) -> Result<TerminalLaunch, String> {
    let c = super::store::get_conn(&*db.lock().map_err(|e| e.to_string())?, &id)?;
    Ok(TerminalLaunch {
        command: terminal_command(&c),
        cwd: dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned(),
    })
}
