//! Qué TUIs pueden tener varias cuentas y cómo se lee, del disco, quién está logueado.

use std::path::Path;

/// Una TUI de fábrica que soporta cuentas: su id más cómo aísla el perfil.
///
/// Los campos ya no se declaran acá: son los de [`crate::agents::ProfileDef`], que vive en
/// el registro junto al resto de lo que la app sabe de esa TUI. Esta struct sigue
/// existiendo porque el resto del módulo la quiere aplanada y con el `agent_id` adentro.
pub(super) struct ProfileSpec {
    pub(super) agent_id: &'static str,
    pub(super) env_var: &'static str,
    pub(super) login_command: &'static str,
    pub(super) marker: &'static str,
    pub(super) label_path: &'static [&'static str],
}

lazy_static::lazy_static! {
    /// Las TUIs del registro que declararon perfil, aplanadas.
    ///
    /// Solo están las TUIs donde el aislamiento se verificó de verdad. Una TUI ausente no
    /// es "todavía no soportada por vaguería": es que no se comprobó que tenga una
    /// variable que mueva el login, y ofrecer cuentas múltiples sin eso daría cuentas que
    /// se pisan entre sí — peor que no ofrecerlas.
    pub(super) static ref PROFILES: Vec<ProfileSpec> = crate::agents::AGENTS
        .iter()
        .filter_map(|a| {
            a.profile.map(|p| ProfileSpec {
                agent_id: a.id,
                env_var: p.env_var,
                login_command: p.login_command,
                marker: p.marker,
                label_path: p.label_path,
            })
        })
        .collect();
}

pub(super) fn spec_for(agent_id: &str) -> Option<&'static ProfileSpec> {
    PROFILES.iter().find(|p| p.agent_id == agent_id)
}

/// El directorio que usa la TUI cuando NADIE le apunta su variable a otro lado.
///
/// Es la cuenta principal: la que ya tenías antes de crear ningún perfil. No tiene fila en
/// `agent_accounts` —no la creó esta app— y por eso no aparecía en ninguna lista, aunque es
/// justamente la que se usa casi siempre.
pub(super) fn default_dir(spec: &ProfileSpec) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(match spec.env_var {
        // Es la raíz de datos XDG, no una carpeta de opencode: su marcador ya incluye el
        // subdirectorio (`opencode/auth.json`).
        "XDG_DATA_HOME" => std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share")),
        "CODEX_HOME" => home.join(".codex"),
        _ => home.join(".claude"),
    })
}

/// Desde dónde se busca el marcador de login de la cuenta principal.
///
/// Casi siempre es su mismo directorio, salvo Claude Code: sin `CLAUDE_CONFIG_DIR` guarda
/// su `.claude.json` en el home, AL LADO de `~/.claude/` y no adentro (ver
/// `usage/trust.rs`, que ya lo resolvía así). Buscarlo en `~/.claude/.claude.json` era leer
/// un archivo que no existe, y la cuenta que el usuario usa siempre figuraba sin sesión.
pub(super) fn system_marker_root(spec: &ProfileSpec, home: &Path, default_dir: &Path) -> std::path::PathBuf {
    match spec.env_var {
        "CLAUDE_CONFIG_DIR" => home.to_path_buf(),
        _ => default_dir.to_path_buf(),
    }
}

// ── Identidad leída del disco ───────────────────────────────────

/// Lee del perfil quién está logueado. Devuelve `(logueado, etiqueta)`.
///
/// Se hace mirando el disco y no guardando el dato en la base a propósito: el login pasa
/// dentro de la TUI, fuera del alcance de la app, y puede caducar o rehacerse sin que nos
/// enteremos. El disco es la única fuente que no puede quedar desactualizada.
pub(super) fn read_identity(dir: &Path, spec: &ProfileSpec) -> (bool, Option<String>) {
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
