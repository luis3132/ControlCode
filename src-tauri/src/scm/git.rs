//! Cómo se invoca a git desde el panel: sin terminal, con tiempo límite y con errores que
//! se puedan mostrar.

use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::util::output_with_timeout;

/// Leer estado, preparar, cambiar de rama: local, tiene que ser rápido.
pub(crate) const LOCAL: Duration = Duration::from_secs(20);
/// Un commit corre los hooks del repo (lint, tests), que pueden tardar.
pub(super) const COMMIT: Duration = Duration::from_secs(180);
/// fetch/pull/push dependen de la red y del tamaño del repo.
pub(super) const NETWORK: Duration = Duration::from_secs(300);

/// Un error que la UI sabe distinguir. Con `Auth` la UI ofrece iniciar sesión en el host
/// (ver `forge`).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ScmError {
    Auth(String),
    Git(String),
}

impl From<std::io::Error> for ScmError {
    fn from(e: std::io::Error) -> Self {
        ScmError::Git(e.to_string())
    }
}

/// Frases con las que git (o ssh, o el credential helper) dice que le faltan credenciales.
const AUTH_HINTS: &[&str] = &[
    "Authentication failed",
    "could not read Username",
    "could not read Password",
    "terminal prompts disabled",
    "Permission denied (publickey",
    "Host key verification failed",
    "invalid credentials",
    "HTTP Basic: Access denied",
    "The requested URL returned error: 403",
    "The requested URL returned error: 401",
];

pub(crate) fn classify_failure(stderr: &str) -> ScmError {
    let message = stderr.trim().to_string();
    if AUTH_HINTS.iter().any(|hint| message.contains(hint)) {
        ScmError::Auth(message)
    } else {
        ScmError::Git(message)
    }
}

fn base(root: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    // Si git necesita un usuario y contraseña, que falle en vez de preguntarlos: acá no
    // hay nadie mirando una terminal, y un proceso esperando input se ve como la app
    // colgada.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");

    // Y sin terminal de control: con la app lanzada desde una consola (`tauri dev`), ssh
    // abre `/dev/tty` directamente para pedir la passphrase — y se queda esperando en esa
    // consola, que nadie mira. En una sesión propia no hay tty que abrir y falla enseguida.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd
}

/// Corre git y devuelve su stdout, o el error ya clasificado.
pub(crate) fn run(root: &str, args: &[&str], limit: Duration) -> Result<Vec<u8>, ScmError> {
    let out = output_with_timeout(&mut base(root, args), limit)
        .map_err(|e| ScmError::Git(format!("git {}: {e}", args.first().unwrap_or(&""))))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    // Algunos "no" de git van por stdout ("nothing to commit"): sin esto el error llegaría
    // vacío y la UI no tendría nada que decir.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let message = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
    Err(classify_failure(&message))
}

pub(crate) fn run_text(root: &str, args: &[&str], limit: Duration) -> Result<String, ScmError> {
    run(root, args, limit).map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// Las operaciones que salen a la red, con las variables con las que git se autentica con
/// la cuenta de la app (ver `forge::git_env`). Sin cuenta para el host, `env` viene vacío y
/// git usa lo que tenga configurado.
pub(crate) fn network(root: &str, args: &[&str], env: &[(String, String)]) -> Result<String, ScmError> {
    network_with(root, args, env, NETWORK)
}

pub(crate) fn network_with(
    root: &str,
    args: &[&str],
    env: &[(String, String)],
    limit: Duration,
) -> Result<String, ScmError> {
    let mut cmd = base(root, args);
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    let out = output_with_timeout(&mut cmd, limit)
        .map_err(|e| ScmError::Git(format!("git {}: {e}", args.first().unwrap_or(&""))))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let message = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
    Err(classify_failure(&message))
}

/// El root del repo que contiene `cwd`, o `None` si no hay repo.
pub(super) fn repo_root(cwd: &str) -> Option<String> {
    run_text(cwd, &["rev-parse", "--show-toplevel"], LOCAL)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
