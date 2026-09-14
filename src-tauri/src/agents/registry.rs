//! La tabla única de las TUIs que la app soporta de fábrica.
//!
//! Antes esto estaba repartido en cuatro tablas, en cuatro archivos, **y una de ellas en
//! TypeScript**: el catálogo acá al lado (`detector.rs`), la carpeta de skills en
//! `skills/links.rs`, la variable de entorno de las cuentas en `accounts/profiles.rs`, y
//! los flags de reanudación en `src/features/sessions/agentResume.ts`. Agregar una TUI
//! significaba acordarse de los cuatro, y olvidarse de uno no rompía nada al compilar:
//! salía como "esta TUI no guarda las sesiones" o "no le puedo poner una segunda cuenta",
//! semanas después y sin pista de por qué.
//!
//! Lo que vive acá es lo **tabular**: un dato por TUI que se puede escribir en una fila.
//! Lo que NO vive acá, a propósito:
//!
//! - **Cómo se descubre una sesión en disco** (`session/title.rs`). Cada TUI guarda sus
//!   transcripts con un formato distinto y eso es algoritmo, no dato; meterlo en una fila
//!   obligaría a inventar un mini-lenguaje. Lo que sí sale de acá es *cuál* estrategia le
//!   toca a cada una ([`AgentDef::sessions`]), que era la parte que estaba implícita.
//! - **El icono** (`src/features/agents/agentIcons.tsx`). Es un componente de React; no
//!   puede cruzar el límite. Se sigue eligiendo por el mismo `id` que se define acá.

use serde::{Deserialize, Serialize};

/// Dónde y cómo deja sus sesiones una TUI. Selecciona la estrategia de `session/title.rs`;
/// el algoritmo de cada una vive allá.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionSource {
    /// `<config>/projects/<slug>/<uuid>.jsonl`, con el slug derivado del cwd.
    ClaudeProjects,
    /// `~/.gemini/tmp/<slug>/chats/session-*.jsonl`, con el slug en un índice aparte.
    GeminiTmp,
    /// `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, con el cwd en la primera línea.
    CodexRollouts,
    /// No deja archivo legible: hay que preguntarle al propio binario.
    ProcessQuery,
    /// `<home>/sessions/<workDirKey>/<sessionId>/`.
    KimiSessions,
    /// No se le conoce forma de reanudar una sesión puntual.
    None,
}

/// Cómo se aísla el perfil de una TUI para tener varias cuentas.
///
/// Solo se declara para las TUIs donde el aislamiento se verificó de verdad. Una TUI sin
/// esto no es "todavía no soportada por vaguería": es que no se comprobó que tenga una
/// variable que mueva el login, y ofrecer cuentas múltiples sin eso daría cuentas que se
/// pisan entre sí — peor que no ofrecerlas.
#[derive(Clone, Copy, Debug)]
pub struct ProfileDef {
    /// Variable que apunta la TUI a un directorio propio.
    pub env_var: &'static str,
    /// Comando que abre el login de esa TUI dentro del perfil.
    pub login_command: &'static str,
    /// Archivo (relativo al perfil) donde la TUI deja rastro de su sesión.
    pub marker: &'static str,
    /// Ruta de claves dentro de ese JSON hasta el identificador de la cuenta. Vacío = esa
    /// TUI no expone quién está logueado y solo se puede saber SI lo está.
    pub label_path: &'static [&'static str],
}

/// Un modelo que la TUI resuelve sola a partir de un alias.
#[derive(Clone, Copy, Debug)]
pub struct ModelAlias {
    /// Lo que recibe el flag de modelo.
    pub id: &'static str,
    pub label: &'static str,
    /// Precio de lista en USD por millón de tokens, entrada y salida. Orientativo: el alias
    /// sigue al último modelo de su clase y el precio puede moverse con él.
    pub cost_in: f64,
    pub cost_out: f64,
    pub context: u64,
}

/// De dónde salen los modelos que se le pueden pedir a una TUI.
#[derive(Clone, Copy, Debug)]
pub enum ModelSource {
    /// Una lista fija de alias.
    Aliases(&'static [ModelAlias]),
    /// Se le pregunta al binario con `opencode models --verbose`, que trae proveedor,
    /// precio, contexto y si el modelo puede usar herramientas.
    OpencodeModels,
    /// No se sabe listarlos.
    Unknown,
}

/// Los alias de `claude --model`. Verificados contra `claude --help` de la 2.1.269 ("an
/// alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')") y `haiku` con una
/// corrida real, que resolvió a `claude-haiku-4-5-20251001`. Precios de lista a junio 2026.
const CLAUDE_MODELS: &[ModelAlias] = &[
    ModelAlias { id: "haiku", label: "Haiku", cost_in: 1.0, cost_out: 5.0, context: 200_000 },
    ModelAlias { id: "sonnet", label: "Sonnet", cost_in: 2.0, cost_out: 10.0, context: 1_000_000 },
    ModelAlias { id: "opus", label: "Opus", cost_in: 5.0, cost_out: 25.0, context: 1_000_000 },
    ModelAlias { id: "fable", label: "Fable", cost_in: 10.0, cost_out: 50.0, context: 1_000_000 },
];

/// Todo lo que la app sabe de una TUI de fábrica, en una fila.
#[derive(Clone, Copy, Debug)]
pub struct AgentDef {
    pub id: &'static str,
    pub label: &'static str,
    /// El binario, tal cual se busca en el `PATH`.
    pub command: &'static str,
    pub version_flag: &'static str,
    /// Carpeta de skills relativa al cwd del proyecto. `None` = no gestiona skills.
    pub skills_dir: Option<&'static str>,
    pub profile: Option<ProfileDef>,
    /// Argumentos para reanudar una sesión puntual, con `{session}` de placeholder.
    /// `None` = no sabe reanudar por id.
    ///
    /// Verificado contra la documentación real de cada CLI, no asumido:
    /// - claude-code: code.claude.com/docs/en/sessions — `--resume <id>` apunta a una
    ///   sesión puntual sin importar el cwd (distinto de `--continue`, que retoma la más
    ///   reciente DEL directorio actual; acá ya sabemos el id exacto).
    /// - gemini-cli: github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
    /// - codex: `resume <id>` es **subcomando**, no flag.
    /// - opencode: `--session <id>` (alias `-s`).
    /// - kimi-code: moonshotai.github.io/kimi-code/en/reference/kimi-command.html —
    ///   `--session <id>` (alias `-S`, mayúscula: distinta de `-s`/`--continue`).
    pub resume: Option<&'static str>,
    pub sessions: SessionSource,
    pub models: ModelSource,
}

pub const AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "claude-code",
        label: "Claude Code",
        command: "claude",
        version_flag: "--version",
        // docs.claude.com/en/docs/claude-code/skills
        skills_dir: Some(".claude/skills"),
        profile: Some(ProfileDef {
            // Verificado: un CLAUDE_CONFIG_DIR vacío se inicializa solo y queda
            // autocontenido (su propio `.claude.json`, sus credenciales, sus transcripts).
            env_var: "CLAUDE_CONFIG_DIR",
            login_command: "claude",
            marker: ".claude.json",
            // Existe desde el primer arranque, así que su MERA existencia no prueba
            // login; `oauthAccount.emailAddress` sí, y de paso es lo que se muestra.
            label_path: &["oauthAccount", "emailAddress"],
        }),
        resume: Some("--resume {session}"),
        sessions: SessionSource::ClaudeProjects,
        models: ModelSource::Aliases(CLAUDE_MODELS),
    },
    AgentDef {
        id: "gemini-cli",
        label: "Gemini CLI",
        command: "gemini",
        version_flag: "--version",
        skills_dir: Some(".agents/skills"),
        profile: None,
        resume: Some("--resume {session}"),
        sessions: SessionSource::GeminiTmp,
        models: ModelSource::Unknown,
    },
    AgentDef {
        id: "codex",
        label: "Codex",
        command: "codex",
        version_flag: "--version",
        skills_dir: Some(".agents/skills"),
        profile: Some(ProfileDef {
            // Codex documenta CODEX_HOME como la raíz de su configuración y credenciales.
            env_var: "CODEX_HOME",
            login_command: "codex login",
            marker: "auth.json",
            label_path: &[],
        }),
        resume: Some("resume {session}"),
        sessions: SessionSource::CodexRollouts,
        models: ModelSource::Unknown,
    },
    AgentDef {
        id: "opencode",
        label: "OpenCode",
        command: "opencode",
        version_flag: "--version",
        skills_dir: Some(".agents/skills"),
        profile: Some(ProfileDef {
            // Verificado: con XDG_DATA_HOME apuntado a un directorio nuevo, opencode
            // escribe su `auth.json` y su base en `<dir>/opencode/` y arranca sin
            // credenciales. La variable es genérica y no propia de opencode, pero eso no
            // molesta: el PTY corre un solo programa, así que redirigirla solo afecta a
            // esa tab.
            env_var: "XDG_DATA_HOME",
            login_command: "opencode auth login",
            marker: "opencode/auth.json",
            label_path: &[],
        }),
        resume: Some("--session {session}"),
        sessions: SessionSource::ProcessQuery,
        models: ModelSource::OpencodeModels,
    },
    AgentDef {
        // Moonshot AI — repo en transición de nombre kimi-cli → kimi-code, el binario real
        // sigue siendo `kimi` (moonshotai.github.io/kimi-code/en/reference/kimi-command.html).
        id: "kimi-code",
        label: "Kimi Code",
        command: "kimi",
        version_flag: "--version",
        skills_dir: Some(".agents/skills"),
        profile: None,
        resume: Some("--session {session}"),
        sessions: SessionSource::KimiSessions,
        models: ModelSource::Unknown,
    },
    AgentDef {
        // No es una TUI de agente: es la salida de emergencia a una terminal pelada. Está
        // en la tabla porque el resto de la app la trata como un agente más (tiene id,
        // icono y tabs), pero no gestiona skills ni cuentas ni sesiones.
        id: "bash",
        label: "Terminal (bash)",
        command: "bash",
        version_flag: "--version",
        skills_dir: None,
        profile: None,
        resume: None,
        sessions: SessionSource::None,
        models: ModelSource::Unknown,
    },
];

/// El único `bash` de la tabla se reporta siempre disponible y sin versión: es el que da
/// la salida de emergencia, y sondearlo con `which` en Windows daría "no instalado".
pub const SHELL_AGENT_ID: &str = "bash";

pub fn agent_def(id: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Etiqueta legible de una TUI de fábrica, por id.
pub fn agent_label(id: &str) -> Option<&'static str> {
    agent_def(id).map(|a| a.label)
}

/// Comando de invocación de una TUI de fábrica, por id.
pub fn agent_command(id: &str) -> Option<&'static str> {
    agent_def(id).map(|a| a.command)
}

/// La tabla, tal como la ve el frontend.
///
/// Va aparte de [`crate::agents::AgentInfo`] a propósito: ése sondea el `PATH` y corre
/// `--version` por cada TUI, así que tarda cientos de milisegundos y llega tarde. Esto es
/// la tabla pelada, sin tocar disco ni lanzar procesos, y por eso se puede pedir antes del
/// primer render — que es lo que permite que `buildResumeCommand` siga siendo síncrona.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistryEntry {
    pub id: String,
    pub label: String,
    pub command: String,
    pub skills_dir: Option<String>,
    pub resume: Option<String>,
    pub supports_accounts: bool,
    pub sessions: SessionSource,
}

/// El catálogo estático de TUIs de fábrica. Sin I/O: responde en el acto.
#[tauri::command]
pub fn agent_registry() -> Vec<AgentRegistryEntry> {
    AGENTS
        .iter()
        .map(|a| AgentRegistryEntry {
            id: a.id.to_string(),
            label: a.label.to_string(),
            command: a.command.to_string(),
            skills_dir: a.skills_dir.map(str::to_string),
            resume: a.resume.map(str::to_string),
            supports_accounts: a.profile.is_some(),
            sessions: a.sessions,
        })
        .collect()
}
