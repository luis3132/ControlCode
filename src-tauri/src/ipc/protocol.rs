//! Protocolo compartido entre la app y la CLI `controlcode`.
//!
//! Transporte: TCP sobre loopback, una línea JSON por request y una por response.
//!
//! Se eligió TCP-en-loopback y no un socket Unix porque el mismo código tiene que
//! funcionar en Windows sin traer un crate de named pipes. El costo es que cualquier
//! proceso local puede *conectarse*, así que la autorización va aparte: la app escribe
//! puerto y token en un archivo de handshake que solo el usuario puede leer, y toda
//! request sin ese token se rechaza. Es el mismo modelo que usan los servidores de
//! desarrollo locales (Jupyter, etc.).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Archivo donde la app publica cómo alcanzarla. La CLI lo lee para conectarse cuando no
/// la lanzó ninguna instancia en particular (una terminal cualquiera del sistema).
pub fn handshake_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".controlcode")
        .join("ipc.json")
}

/// La variable con la que cada instancia les dice a sus hijos —las TUIs de sus tabs, las
/// tareas de la flota y, a través de ellos, los puentes `ccode mcp`— cuál es SU handshake.
///
/// Existe porque el archivo global es uno solo: con dos instancias abiertas (la app abierta
/// dos veces, un `tauri dev` al lado de la instalada, el reinicio de una actualización) la
/// última en arrancar lo pisaba, y la primera en cerrarse lo borraba. Desde ahí los agentes
/// de la que seguía abierta recibían "Control Code no parece estar corriendo" hablando
/// desde adentro de la app.
pub const HANDSHAKE_ENV: &str = "CONTROLCODE_HANDSHAKE";

/// El handshake propio de la instancia con ese PID.
pub fn instance_handshake_path(pid: u32) -> PathBuf {
    handshake_path().with_file_name("ipc").join(format!("{pid}.json"))
}

/// El handshake que tiene que usar la CLI: el de la instancia que la lanzó si existe, si no
/// el global. Si esa instancia se cerró, el global lleva a la que esté abierta ahora.
pub fn client_handshake_path() -> PathBuf {
    std::env::var_os(HANDSHAKE_ENV)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(handshake_path)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Handshake {
    pub port: u16,
    pub token: String,
    /// PID de la app. La CLI lo reporta en los errores para que se note enseguida si el
    /// archivo quedó de una instancia muerta.
    pub pid: u32,
    /// Versión del protocolo. Si la CLI y la app quedaron desalineadas (por ejemplo tras
    /// actualizar la app sin reinstalar la CLI), conviene decirlo con claridad en vez de
    /// fallar de formas raras al deserializar.
    pub protocol: u32,
}

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub token: String,
    /// `grupo.acción`, ej. `tab.list`, `workspace.open`.
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(data: serde_json::Value) -> Self {
        Response { ok: true, data: Some(data), error: None }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Response { ok: false, data: None, error: Some(message.into()) }
    }
}

/// Extrae un argumento string obligatorio, con un error que nombra el que falta en vez
/// de un "invalid type" genérico.
pub fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Falta el argumento --{key}"))
}

pub fn arg_str_opt(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub fn arg_u64_opt(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}
