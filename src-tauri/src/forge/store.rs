//! Las cuentas en la base: quién es y en qué host. El token no está acá (ver `secret`).

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::provider::{bare_host, ForgeKind};
use super::secret::{storage_of, Storage};
use crate::database::DbConnection;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAccount {
    pub id: String,
    pub kind: ForgeKind,
    pub host: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    /// `oauth` (código de dispositivo) o `token` (pegado a mano).
    pub auth: String,
    pub git_user: Option<String>,
    pub created_at: i64,
    /// Dónde quedó el token. Se completa al listar.
    pub storage: Option<Storage>,
}

pub(super) fn db(app: &AppHandle) -> Result<DbConnection, String> {
    app.try_state::<DbConnection>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "La base de datos todavía no está lista".to_string())
}

pub(super) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

const COLUMNS: &str = "id, kind, host, login, name, avatar_url, auth, git_user, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<GitAccount> {
    let kind: String = r.get(1)?;
    Ok(GitAccount {
        id: r.get(0)?,
        kind: ForgeKind::parse(&kind).unwrap_or(ForgeKind::Other),
        host: r.get(2)?,
        login: r.get(3)?,
        name: r.get(4)?,
        avatar_url: r.get(5)?,
        auth: r.get(6)?,
        git_user: r.get(7)?,
        created_at: r.get(8)?,
        storage: None,
    })
}

pub(super) fn list(conn: &Connection) -> Vec<GitAccount> {
    let Ok(mut stmt) = conn.prepare(&format!("SELECT {COLUMNS} FROM git_accounts ORDER BY host, login")) else {
        return Vec::new();
    };
    stmt.query_map([], row).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

pub(super) fn list_with_storage(app: &AppHandle) -> Result<Vec<GitAccount>, String> {
    let db = db(app)?;
    let dir = data_dir(app)?;
    let mut accounts = list(&db.lock().unwrap());
    for a in &mut accounts {
        a.storage = Some(storage_of(&dir, &a.id));
    }
    Ok(accounts)
}

pub(super) fn get(conn: &Connection, id: &str) -> Option<GitAccount> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM git_accounts WHERE id = ?1"), [id], row)
        .optional()
        .ok()
        .flatten()
}

/// Guarda la cuenta. Si ya había una con el mismo host y login (volver a iniciar sesión),
/// se actualiza esa y se conserva su id — que es la clave de su token en el llavero y de
/// las elecciones por repo.
pub(super) fn upsert(conn: &Connection, account: &GitAccount) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM git_accounts WHERE host = ?1 AND login = ?2",
            params![account.host, account.login],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let id = existing.unwrap_or_else(|| account.id.clone());
    conn.execute(
        "INSERT INTO git_accounts (id, kind, host, login, name, avatar_url, auth, git_user, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
           avatar_url = excluded.avatar_url, auth = excluded.auth, git_user = excluded.git_user",
        params![
            id,
            account.kind.as_str(),
            account.host,
            account.login,
            account.name,
            account.avatar_url,
            account.auth,
            account.git_user,
            account.created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub(super) fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM git_repo_accounts WHERE account_id = ?1", [id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM git_accounts WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Las cuentas de un host, comparando sin puerto: un remoto SSH no lo trae y uno HTTPS
/// puede traerlo o no. `ssh.github.com` es el alias de SSH de github.com.
pub(super) fn for_host(conn: &Connection, host: &str) -> Vec<GitAccount> {
    let host = host.strip_prefix("ssh.").unwrap_or(host);
    list(conn)
        .into_iter()
        .filter(|a| bare_host(&a.host).eq_ignore_ascii_case(bare_host(host)))
        .collect()
}

pub(super) fn repo_choice(conn: &Connection, root: &str) -> Option<String> {
    conn.query_row("SELECT account_id FROM git_repo_accounts WHERE root = ?1", [root], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub(super) fn set_repo_choice(conn: &Connection, root: &str, account_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO git_repo_accounts (root, account_id) VALUES (?1, ?2)
         ON CONFLICT(root) DO UPDATE SET account_id = excluded.account_id",
        params![root, account_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// La cuenta con la que trabaja un repo de este host: la elegida para ese repo si sigue
/// siendo de ese host, si no la primera.
pub(super) fn pick(conn: &Connection, root: Option<&str>, host: &str) -> (Option<GitAccount>, Vec<GitAccount>) {
    let candidates = for_host(conn, host);
    let chosen = root
        .and_then(|r| repo_choice(conn, r))
        .and_then(|id| candidates.iter().find(|a| a.id == id).cloned())
        .or_else(|| candidates.first().cloned());
    (chosen, candidates)
}
