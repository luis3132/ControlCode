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

/// Archivo donde la app publica cómo alcanzarla. La CLI lo lee para conectarse.
pub fn handshake_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".controlcode")
        .join("ipc.json")
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// El handshake y las requests tienen que sobrevivir el ida y vuelta: son el contrato
    /// entre dos binarios que se compilan juntos pero corren por separado.
    #[test]
    fn wire_format_round_trips() {
        let hs = Handshake {
            port: 45123,
            token: "tok".into(),
            pid: 42,
            protocol: PROTOCOL_VERSION,
        };
        let back: Handshake = serde_json::from_str(&serde_json::to_string(&hs).unwrap()).unwrap();
        assert_eq!(back.port, 45123);
        assert_eq!(back.token, "tok");
        assert_eq!(back.protocol, PROTOCOL_VERSION);

        let req = Request {
            token: "tok".into(),
            command: "tab.create".into(),
            args: json!({ "cwd": "/repo", "skills": ["a", "b"] }),
        };
        let back: Request = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back.command, "tab.create");
        assert_eq!(back.args["skills"][1], "b");
    }

    /// `args` es opcional en el cable: un comando sin flags no debería tener que mandar
    /// un objeto vacío explícito.
    #[test]
    fn request_without_args_deserializes() {
        let req: Request =
            serde_json::from_str(r#"{"token":"t","command":"tab.list"}"#).unwrap();
        assert!(req.args.is_null());
    }

    /// Las respuestas omiten el campo que no aplica, para que la CLI pueda distinguir
    /// "sin datos" de "hubo error" sin mirar `ok`.
    #[test]
    fn responses_omit_the_irrelevant_field() {
        let ok = serde_json::to_string(&Response::ok(json!({ "tabs": [] }))).unwrap();
        assert!(ok.contains("\"data\""));
        assert!(!ok.contains("\"error\""));

        let err = serde_json::to_string(&Response::err("no existe")).unwrap();
        assert!(err.contains("\"error\":\"no existe\""));
        assert!(!err.contains("\"data\""));
    }

    #[test]
    fn missing_argument_names_the_flag_the_user_forgot() {
        let err = arg_str(&json!({}), "cwd").unwrap_err();
        assert_eq!(err, "Falta el argumento --cwd");
        assert_eq!(arg_str(&json!({ "cwd": "/x" }), "cwd").unwrap(), "/x");
    }
}
