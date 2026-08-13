//! Qué TUIs pueden tener varias cuentas y cómo se lee, del disco, quién está logueado.

use std::path::Path;

/// Cómo se aísla el perfil de una TUI concreta.
///
/// Solo están acá las TUIs donde el aislamiento se verificó de verdad. Una TUI ausente de
/// esta tabla no es "todavía no soportada por vaguería": es que no se comprobó que tenga
/// una variable que mueva el login, y ofrecer cuentas múltiples sin eso daría cuentas que
/// se pisan entre sí — peor que no ofrecerlas.
pub(super) struct ProfileSpec {
    pub(super) agent_id: &'static str,
    /// Variable que apunta la TUI a un directorio propio.
    pub(super) env_var: &'static str,
    /// Comando que abre el login de esa TUI dentro del perfil.
    pub(super) login_command: &'static str,
    /// Archivo (relativo al perfil) donde la TUI deja rastro de su sesión.
    pub(super) marker: &'static str,
    /// Ruta de claves dentro de ese JSON hasta el identificador de la cuenta. Vacío = esa
    /// TUI no expone quién está logueado y solo se puede saber SI lo está.
    pub(super) label_path: &'static [&'static str],
}

pub(super) const PROFILES: &[ProfileSpec] = &[
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

pub(super) fn spec_for(agent_id: &str) -> Option<&'static ProfileSpec> {
    PROFILES.iter().find(|p| p.agent_id == agent_id)
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
