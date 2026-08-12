//! El almacén de cuentas: dónde vive cada perfil, cómo se valida su nombre y cómo se
//! traduce una fila de la base al tipo que ve el frontend.

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::profiles::{read_identity, spec_for};

pub(super) fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Nombre de la cuenta ─────────────────────────────────────────

/// El nombre que elige el usuario ES el nombre de la carpeta, así que se valida como tal.
///
/// No alcanza con rechazar `/`: `..` sola escaparía del almacén, y en Windows además hay
/// nombres reservados (`CON`, `NUL`, …) que no se pueden crear. Se acepta un conjunto
/// chico y explícito en vez de intentar listar todo lo prohibido.
pub fn validate_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    if name.len() > 40 {
        return Err("El nombre no puede tener más de 40 caracteres".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Solo se permiten letras, números, '-', '_' y '.'".into());
    }
    if name.starts_with('.') || name.chars().all(|c| c == '.') {
        return Err("El nombre no puede empezar con '.'".into());
    }
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3",
    ];
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err("Ese nombre está reservado por el sistema".into());
    }
    Ok(())
}

// ── Almacén ─────────────────────────────────────────────────────

pub(super) fn accounts_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta de datos de la app: {e}"))?;
    Ok(base.join("accounts"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub id: String,
    pub agent_id: String,
    /// Nombre simbólico elegido por el usuario; también es el nombre de la carpeta.
    pub name: String,
    pub dir: String,
    pub env_var: String,
    pub login_command: String,
    /// Si la TUI dejó rastro de una sesión iniciada dentro de este perfil.
    pub logged_in: bool,
    /// Mail (u otro identificador) de la cuenta, cuando la TUI lo expone.
    pub label: Option<String>,
    pub created_at: i64,
}

/// Una TUI que soporta cuentas múltiples, con el dato de si está instalada.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapableAgent {
    pub agent_id: String,
    pub label: String,
    pub env_var: String,
    pub installed: bool,
}

pub(super) fn row_to_account(
    id: String,
    agent_id: String,
    name: String,
    dir: String,
    created_at: i64,
) -> Option<AgentAccount> {
    let spec = spec_for(&agent_id)?;
    let path = PathBuf::from(&dir);
    let (logged_in, label) = read_identity(&path, spec);
    Some(AgentAccount {
        id,
        agent_id,
        name,
        dir,
        env_var: spec.env_var.to_string(),
        login_command: spec.login_command.to_string(),
        logged_in,
        label,
        created_at,
    })
}

/// Variables de entorno con las que hay que lanzar un proceso para que use esta cuenta.
///
/// Es lo único que necesita saber quien abre una tab (o la terminal de login): un mapa que
/// se pasa tal cual a `pty_create`.
pub fn env_for_account(db: &DbConnection, account_id: &str) -> Option<HashMap<String, String>> {
    let conn = db.lock().ok()?;
    let (agent_id, dir): (String, String) = conn
        .query_row(
            "SELECT agent_id, dir FROM agent_accounts WHERE id = ?1",
            [account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let spec = spec_for(&agent_id)?;
    Some(HashMap::from([(spec.env_var.to_string(), dir)]))
}

/// Directorio de perfil de una cuenta. Es la raíz donde la TUI guarda TODO lo suyo —
/// incluidas las sesiones — así que es lo que necesita `session::title` para no buscar los
/// transcripts de una tab con cuenta alternativa en la carpeta del sistema.
pub fn dir_for(db: &DbConnection, account_id: &str) -> Option<String> {
    let conn = db.lock().ok()?;
    dir_for_conn(&conn, account_id)
}

/// Igual que `dir_for`, sobre una conexión ya tomada — para quien está adentro del lock y
/// volver a pedirlo sería un deadlock.
pub fn dir_for_conn(conn: &rusqlite::Connection, account_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT dir FROM agent_accounts WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )
    .ok()
}
