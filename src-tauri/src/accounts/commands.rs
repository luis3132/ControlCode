//! Los comandos que invoca el frontend para administrar cuentas.

use crate::database::DbConnection;
use std::collections::HashMap;
use tauri::AppHandle;

use super::profiles::{spec_for, PROFILES};
use crate::util::now_ts;

use super::store::{
    accounts_root, env_for_account, row_to_account, validate_name, AccountCapableAgent,
    AgentAccount,
};

/// TUIs que pueden tener varias cuentas, marcando cuáles están instaladas.
///
/// Las instaladas que NO aparecen acá (gemini-cli, kimi-code) es porque no se les conoce
/// una variable que mueva el login. El frontend las muestra como no soportadas en vez de
/// dejar que el usuario cree una cuenta que después se pisaría con la del sistema.
#[tauri::command]
pub async fn account_capable_agents() -> Result<Vec<AccountCapableAgent>, String> {
    tokio::task::spawn_blocking(|| {
        PROFILES
            .iter()
            .map(|spec| AccountCapableAgent {
                agent_id: spec.agent_id.to_string(),
                label: crate::agents::agent_label(spec.agent_id)
                    .unwrap_or(spec.agent_id)
                    .to_string(),
                env_var: spec.env_var.to_string(),
                installed: crate::agents::agent_command(spec.agent_id)
                    .map(crate::agents::command_exists)
                    .unwrap_or(false),
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_accounts(db: tauri::State<DbConnection>) -> Result<Vec<AgentAccount>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, agent_id, name, dir, created_at FROM agent_accounts
             ORDER BY agent_id, name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut accounts = Vec::new();
    for row in rows {
        let (id, agent_id, name, dir, created_at) = row.map_err(|e| e.to_string())?;
        // Una cuenta de una TUI que ya no está en PROFILES se omite en vez de romper la
        // lista entera: no hay forma de lanzarla, pero su carpeta sigue en el disco.
        if let Some(account) = row_to_account(id, agent_id, name, dir, created_at) {
            accounts.push(account);
        }
    }
    Ok(accounts)
}

#[tauri::command]
pub fn create_agent_account(
    agent_id: String,
    name: String,
    app: AppHandle,
    db: tauri::State<DbConnection>,
) -> Result<AgentAccount, String> {
    if spec_for(&agent_id).is_none() {
        return Err(format!("'{agent_id}' no soporta varias cuentas"));
    }
    let name = name.trim().to_string();
    validate_name(&name)?;

    let dir = accounts_root(&app)?.join(&agent_id).join(&name);
    // El directorio se crea vacío y la TUI lo inicializa sola en su primer arranque. Si ya
    // existía (cuenta borrada de la base pero no del disco), se reutiliza tal cual: sus
    // credenciales siguen ahí y volver a loguearse sería trabajo de más.
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear la carpeta de la cuenta: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_ts();
    let dir_str = dir.to_string_lossy().to_string();

    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_accounts (id, agent_id, name, dir, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, agent_id, name, dir_str, created_at],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("Ya existe una cuenta '{name}' para esta TUI")
            } else {
                e.to_string()
            }
        })?;
    }

    row_to_account(id, agent_id, name, dir_str, created_at)
        .ok_or_else(|| "No se pudo leer la cuenta recién creada".to_string())
}

/// Borra la cuenta. `delete_files` decide si también se va la carpeta con las credenciales.
///
/// Están separados a propósito: sacarla de la app es reversible (se vuelve a agregar con el
/// mismo nombre y el login sigue ahí), borrar la carpeta no lo es.
#[tauri::command]
pub fn delete_agent_account(
    id: String,
    delete_files: bool,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let dir: Option<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let dir = conn
            .query_row(
                "SELECT dir FROM agent_accounts WHERE id = ?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        conn.execute("DELETE FROM agent_accounts WHERE id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        dir
    };

    if delete_files {
        if let Some(dir) = dir {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("La cuenta se quitó, pero no se pudo borrar {dir}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_account_env(
    account_id: String,
    db: tauri::State<DbConnection>,
) -> Result<HashMap<String, String>, String> {
    env_for_account(&db, &account_id).ok_or_else(|| "Cuenta no encontrada".to_string())
}
