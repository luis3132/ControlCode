//! El cupo de una cuenta de Codex, preguntado a su propio `app-server`.
//!
//! `codex app-server --listen stdio://` habla JSON-RPC por stdin/stdout. Dos llamadas
//! alcanzan: `account/read` (quién es y qué plan tiene) y `account/rateLimits/read` (las
//! ventanas de cinco horas y de la semana). Ninguna gasta cupo, y el que lee las
//! credenciales es Codex: la app no las toca.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::database::DbConnection;
use crate::runs::quota::Quota;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Lo que el panel de consumo muestra de una cuenta de Codex.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub email: Option<String>,
    /// `plus`, `pro`, `team`… o nada con API key.
    pub plan: Option<String>,
    /// `chatgpt` o `apiKey`. Con API key no hay ventanas de límite: se cobra por uso.
    pub auth: Option<String>,
    pub quota: Option<Quota>,
    /// Epoch en segundos de la consulta. 0 = nunca se preguntó.
    pub fetched_at: i64,
}

impl CodexUsage {
    fn empty() -> Self {
        CodexUsage { email: None, plan: None, auth: None, quota: None, fetched_at: 0 }
    }
}

fn usage_key(account_key: &str) -> String {
    format!("usage.codex.v1.{account_key}")
}

fn load(db: &DbConnection, account_key: &str) -> Option<CodexUsage> {
    let raw = crate::database::get_setting(db, &usage_key(account_key)).ok()??;
    serde_json::from_str(&raw).ok()
}

fn store(db: &DbConnection, account_key: &str, usage: &CodexUsage) {
    if let Ok(raw) = serde_json::to_string(usage) {
        let _ = crate::database::set_setting(db, &usage_key(account_key), &raw);
    }
}

/// El cupo de una cuenta de Codex.
///
/// Sin `force` devuelve lo guardado tal cual (o uno vacío, con `fetchedAt` 0): quien decide
/// si hace falta volver a preguntar es la UI, igual que con Claude. Con `force` levanta el
/// `app-server`, y lo que sale queda guardado también donde lo lee el ruteo de la flota.
#[tauri::command]
pub async fn codex_account_usage(
    account_id: String,
    force: Option<bool>,
    db: tauri::State<'_, DbConnection>,
) -> Result<CodexUsage, String> {
    let force = force.unwrap_or(true);
    let db = (*db).clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !force {
            return Ok(load(&db, &account_id).unwrap_or_else(CodexUsage::empty));
        }
        let env = if account_id.starts_with("system:") {
            HashMap::new()
        } else {
            super::env_for_account(&db, &account_id).ok_or("accounts.plan.problem.accountMissing")?
        };
        let program = crate::agents::agent_command("codex").ok_or("accounts.plan.problem.commandUnknown")?;
        let mut usage = ask(program, &env)?;
        usage.fetched_at = crate::util::now_ts();
        // La clave es la de `runs::quota::account_key`: el id de la cuenta, o `system:codex`.
        if let Some(quota) = &usage.quota {
            crate::runs::quota::record(&db, &account_id, quota.clone(), usage.fetched_at);
        }
        store(&db, &account_id, &usage);
        Ok(usage)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `account/read` y `account/rateLimits/read` en un solo `app-server`. Con API key no hay
/// ventanas: `quota` queda vacío.
fn ask(program: &str, env: &HashMap<String, String>) -> Result<CodexUsage, String> {
    let mut command = crate::util::program(program);
    command.args(["app-server", "--listen", "stdio://"]).envs(env);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn().map_err(|_| "accounts.plan.problem.codexStart".to_string())?;
    let mut server = CodexServer::new(child)?;
    server.initialize()?;
    let read = server.call("account/read", json!({ "refreshToken": false }))?;
    let account = read.get("account");
    let text = |key: &str| {
        account
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let quota = server
        .call("account/rateLimits/read", json!({}))
        .ok()
        .and_then(|limits| crate::runs::quota::parse_codex_rate_limits(&limits));
    Ok(CodexUsage {
        email: text("email"),
        plan: text("planType"),
        auth: text("type"),
        quota,
        fetched_at: 0,
    })
}

struct CodexServer {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl CodexServer {
    fn new(mut child: Child) -> Result<Self, String> {
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            terminate(&mut child);
            return Err("accounts.plan.problem.codexStart".into());
        };
        if let Some(mut stderr) = child.stderr.take() {
            // Se vacía para que un pipe lleno no trabe al servidor. No se muestra: puede
            // traer rutas del perfil o detalles del proveedor.
            thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            });
        }
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self { child, stdin: Some(stdin), lines, next_id: 1 })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("accounts.plan.problem.codexClosed")?;
        let mut line = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .and_then(|_| stdin.flush())
            .map_err(|_| "accounts.plan.problem.codexClosed".to_string())
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.call(
            "initialize",
            json!({
                "clientInfo": { "name": "controlcode", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": {}
            }),
        )?;
        self.send(&json!({ "method": "initialized", "params": {} }))
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        receive_response(&self.lines, id, REQUEST_TIMEOUT)
    }
}

/// La respuesta a `id`, salteando las notificaciones y los pedidos del servidor.
pub(super) fn receive_response(lines: &Receiver<String>, id: u64, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = lines.recv_timeout(remaining).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => "accounts.plan.problem.codexTimeout".to_string(),
            mpsc::RecvTimeoutError::Disconnected => "accounts.plan.problem.codexClosed".to_string(),
        })?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if message.get("error").is_some() {
            return Err("accounts.plan.problem.codexRejected".into());
        }
        return message.get("result").cloned().ok_or_else(|| "accounts.plan.problem.codexRejected".into());
    }
}

impl Drop for CodexServer {
    fn drop(&mut self) {
        // Cerrar stdin le da la chance de salir solo; si no, se lo mata.
        self.stdin.take();
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        terminate(&mut self.child);
    }
}

/// Mata el `app-server` y, en Windows, lo que haya lanzado (`codex.cmd` pasa por un shell).
fn terminate(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = crate::util::program("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn la_respuesta_se_encuentra_entre_notificaciones() {
        let (tx, rx) = mpsc::channel();
        for line in [
            r#"{"method":"account/updated","params":{}}"#,
            "no es json",
            r#"{"id":1,"result":{"viejo":true}}"#,
            r#"{"id":2,"result":{"ok":true}}"#,
        ] {
            tx.send(line.to_string()).unwrap();
        }
        let got = receive_response(&rx, 2, Duration::from_secs(1)).unwrap();
        assert_eq!(got, json!({ "ok": true }));
    }

    #[test]
    fn un_error_o_un_servidor_que_se_cierra_se_dicen() {
        let (tx, rx) = mpsc::channel();
        tx.send(r#"{"id":1,"error":{"code":-32600}}"#.to_string()).unwrap();
        assert_eq!(
            receive_response(&rx, 1, Duration::from_secs(1)).unwrap_err(),
            "accounts.plan.problem.codexRejected"
        );
        drop(tx);
        assert_eq!(
            receive_response(&rx, 2, Duration::from_secs(1)).unwrap_err(),
            "accounts.plan.problem.codexClosed"
        );
    }
}
