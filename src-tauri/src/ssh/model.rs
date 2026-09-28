//! Los tipos que viajan al frontend.

use serde::{Deserialize, Serialize};

/// Una computadora a la que se llega por SSH.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub id: String,
    /// Cómo la nombran la persona y los agentes (`ssh_run { host: "servidor" }`). Único.
    pub name: String,
    /// IP, nombre de red o un alias de `~/.ssh/config`.
    pub host: String,
    /// Sin usuario, el que diga `~/.ssh/config` o el local.
    pub user: Option<String>,
    /// Sin puerto, el que diga `~/.ssh/config` o el 22.
    pub port: Option<u16>,
    /// Clave privada a usar. Sin clave, las de siempre (`ssh-agent`, `~/.ssh/id_*`).
    pub identity_file: Option<String>,
    /// Carpeta donde arrancan las terminales y los comandos. Sin carpeta, el home remoto.
    pub remote_dir: Option<String>,
    /// Si los agentes pueden verla y usarla.
    pub agent_access: bool,
    pub created_at: i64,
}

/// Lo que manda el formulario: alta si no trae `id`, edición si lo trae.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionDraft {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_dir: Option<String>,
    #[serde(default = "yes")]
    pub agent_access: bool,
}

fn yes() -> bool {
    true
}

/// Lo que devolvió un comando remoto.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutput {
    /// `None` si `ssh` terminó por una señal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// El resultado de "Probar" en Configuración.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub ok: bool,
    /// Qué contestó el otro equipo, o por qué no se pudo.
    pub detail: String,
    /// Qué hacer, cuando el error es uno de los conocidos.
    pub hint: Option<String>,
    pub elapsed_ms: u64,
}

/// Lo que necesita el frontend para abrir una terminal en esa computadora.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunch {
    pub command: String,
    /// Carpeta local donde arranca el proceso `ssh`: el home, porque no importa.
    pub cwd: String,
}
