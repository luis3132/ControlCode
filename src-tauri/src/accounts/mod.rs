//! Varias cuentas de una misma TUI, conviviendo.
//!
//! ## Cómo funciona
//!
//! Las CLIs de agentes guardan su login en un directorio propio (`~/.claude`, `~/.codex`,
//! …). Casi todas dejan mover ese directorio con una variable de entorno, y al hacerlo se
//! llevan TODO con él: credenciales, configuración e historial. O sea que "una cuenta" es,
//! literalmente, un directorio: se apunta la variable a otro lado y la TUI arranca como si
//! fuera una instalación nueva, sin tocar la del sistema.
//!
//! Cada cuenta vive en `<datos de la app>/accounts/<agente>/<nombre>`, y lanzar una tab con
//! esa cuenta es pasarle esa variable al PTY — algo que `pty_create` ya sabía hacer para
//! las TUIs custom.
//!
//! ## Por qué no symlinks
//!
//! Tentaba enlazar el directorio "activo" y cambiar el enlace al elegir cuenta. No sirve:
//! las TUIs reescriben sus archivos de credenciales en el lugar, así que dos procesos
//! vivos con cuentas distintas se pisarían a través del mismo enlace, y cambiar de cuenta
//! con una sesión abierta le movería el piso. Una variable por proceso no tiene ese
//! problema: cada tab queda apuntada a su directorio para siempre.
//!
//! ## Qué NO hace este módulo
//!
//! No lee, no copia y no escribe credenciales. El login lo hace la TUI, en su terminal,
//! como si la hubieras abierto a mano; acá solo se crea el directorio vacío y se apunta la
//! variable. Lo único que se lee de adentro es el campo con el mail de la cuenta, para
//! poder mostrar "trabajo → vos@empresa.com" en vez de un nombre suelto.

use crate::database::DbConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Cómo se aísla el perfil de una TUI concreta.
///
/// Solo están acá las TUIs donde el aislamiento se verificó de verdad. Una TUI ausente de
/// esta tabla no es "todavía no soportada por vaguería": es que no se comprobó que tenga
/// una variable que mueva el login, y ofrecer cuentas múltiples sin eso daría cuentas que
/// se pisan entre sí — peor que no ofrecerlas.
struct ProfileSpec {
    agent_id: &'static str,
    /// Variable que apunta la TUI a un directorio propio.
    env_var: &'static str,
    /// Comando que abre el login de esa TUI dentro del perfil.
    login_command: &'static str,
    /// Archivo (relativo al perfil) donde la TUI deja rastro de su sesión.
    marker: &'static str,
    /// Ruta de claves dentro de ese JSON hasta el identificador de la cuenta. Vacío = esa
    /// TUI no expone quién está logueado y solo se puede saber SI lo está.
    label_path: &'static [&'static str],
}

const PROFILES: &[ProfileSpec] = &[
    // Verificado: un CLAUDE_CONFIG_DIR vacío se inicializa solo y queda autocontenido
    // (su propio `.claude.json`, sus credenciales, sus transcripts).
    ProfileSpec {
        agent_id: "claude-code",
        env_var: "CLAUDE_CONFIG_DIR",
        login_command: "claude",
        marker: ".claude.json",
        // Existe desde el primer arranque, así que su MERA existencia no prueba login;
        // `oauthAccount.emailAddress` sí, y de paso es lo que se muestra.
        label_path: &["oauthAccount", "emailAddress"],
    },
    // Verificado: con XDG_DATA_HOME apuntado a un directorio nuevo, opencode escribe su
    // `auth.json` y su base en `<dir>/opencode/` y arranca sin credenciales.
    //
    // La variable es genérica y no propia de opencode, pero eso no molesta: el PTY corre
    // un solo programa, así que redirigirla solo afecta a esa tab.
    ProfileSpec {
        agent_id: "opencode",
        env_var: "XDG_DATA_HOME",
        login_command: "opencode auth login",
        marker: "opencode/auth.json",
        label_path: &[],
    },
    // Codex documenta CODEX_HOME como la raíz de su configuración y credenciales.
    ProfileSpec {
        agent_id: "codex",
        env_var: "CODEX_HOME",
        login_command: "codex login",
        marker: "auth.json",
        label_path: &[],
    },
];

fn spec_for(agent_id: &str) -> Option<&'static ProfileSpec> {
    PROFILES.iter().find(|p| p.agent_id == agent_id)
}

fn now_ts() -> i64 {
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

// ── Identidad leída del disco ───────────────────────────────────

/// Lee del perfil quién está logueado. Devuelve `(logueado, etiqueta)`.
///
/// Se hace mirando el disco y no guardando el dato en la base a propósito: el login pasa
/// dentro de la TUI, fuera del alcance de la app, y puede caducar o rehacerse sin que nos
/// enteremos. El disco es la única fuente que no puede quedar desactualizada.
fn read_identity(dir: &Path, spec: &ProfileSpec) -> (bool, Option<String>) {
    let marker = dir.join(spec.marker);
    let Ok(raw) = std::fs::read_to_string(&marker) else {
        return (false, None);
    };

    if spec.label_path.is_empty() {
        // Sin campo conocido: solo se puede decir si hay algo. Un `{}` es el archivo que
        // deja la TUI al arrancar sin loguearse, así que no cuenta.
        let trimmed = raw.trim();
        return (!trimmed.is_empty() && trimmed != "{}", None);
    }

    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (false, None);
    };
    let mut cursor = &json;
    for key in spec.label_path {
        match cursor.get(key) {
            Some(next) => cursor = next,
            None => return (false, None),
        }
    }
    match cursor.as_str().filter(|s| !s.is_empty()) {
        Some(label) => (true, Some(label.to_string())),
        None => (false, None),
    }
}

// ── Almacén ─────────────────────────────────────────────────────

fn accounts_root(app: &AppHandle) -> Result<PathBuf, String> {
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

fn row_to_account(
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

// ── Comandos ────────────────────────────────────────────────────

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
    conn.query_row(
        "SELECT dir FROM agent_accounts WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn agent_account_env(
    account_id: String,
    db: tauri::State<DbConnection>,
) -> Result<HashMap<String, String>, String> {
    env_for_account(&db, &account_id).ok_or_else(|| "Cuenta no encontrada".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mismo helper que `session::title`: un directorio propio por test, que se borra solo.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("cc-accounts-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write(&self, rel: &str, body: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_names_that_would_escape_the_store() {
        assert!(validate_name("..").is_err());
        assert!(validate_name("../otra").is_err());
        assert!(validate_name("con/con").is_err());
        assert!(validate_name(".oculta").is_err());
    }

    #[test]
    fn rejects_windows_reserved_names() {
        assert!(validate_name("NUL").is_err());
        assert!(validate_name("com1").is_err());
    }

    #[test]
    fn accepts_ordinary_names() {
        assert!(validate_name("trabajo").is_ok());
        assert!(validate_name("cuenta-2").is_ok());
        assert!(validate_name("luis_personal").is_ok());
        assert!(validate_name("v1.0").is_ok());
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"a".repeat(41)).is_err());
    }

    fn spec(agent: &str) -> &'static ProfileSpec {
        spec_for(agent).unwrap()
    }

    #[test]
    fn claude_profile_is_not_logged_in_just_because_the_file_exists() {
        // Es el caso real, verificado: `.claude.json` se crea en el primer arranque, mucho
        // antes de que haya login. Contar eso como cuenta activa mostraría cuentas fantasma.
        let dir = TempDir::new();
        dir.write(".claude.json", r#"{"autoUpdates":true}"#);
        assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None));
    }

    #[test]
    fn claude_profile_reports_the_account_email() {
        let dir = TempDir::new();
        dir.write(
            ".claude.json",
            r#"{"oauthAccount":{"emailAddress":"vos@ejemplo.com"}}"#,
        );
        assert_eq!(
            read_identity(dir.path(), spec("claude-code")),
            (true, Some("vos@ejemplo.com".to_string()))
        );
    }

    #[test]
    fn opencode_profile_ignores_an_empty_auth_file() {
        let dir = TempDir::new();
        dir.write("opencode/auth.json", "{}");
        assert_eq!(read_identity(dir.path(), spec("opencode")), (false, None));

        dir.write("opencode/auth.json", r#"{"anthropic":{"type":"oauth"}}"#);
        assert_eq!(read_identity(dir.path(), spec("opencode")), (true, None));
    }

    #[test]
    fn a_broken_json_does_not_report_a_logged_in_account() {
        let dir = TempDir::new();
        dir.write(".claude.json", "{no es json");
        assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None));
    }

    #[test]
    fn missing_profile_dir_is_simply_not_logged_in() {
        let dir = TempDir::new();
        assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None));
    }
}
