//! Iniciar sesión con el navegador: el flujo de "código de dispositivo" de OAuth
//! (RFC 8628), el mismo de `gh auth login` y de VS Code.
//!
//! 1. La app le pide al host un código para mostrar.
//! 2. El usuario abre la página del host, pega el código y autoriza.
//! 3. Mientras tanto la app pregunta cada `interval` segundos si ya autorizó.
//!
//! No hace falta un servidor local que reciba la redirección ni un secreto de cliente:
//! por eso sirve en una app de escritorio, donde cualquier secreto embebido sería público.
//!
//! ## Los client IDs
//!
//! Son los de las aplicaciones OAuth registradas a nombre de ControlCode en cada host. No
//! son secretos (van en el binario), pero sin ellos no hay flujo: la UI esconde el botón y
//! queda el token personal. Se pueden fijar al compilar con `CC_GITHUB_CLIENT_ID` y
//! `CC_GITLAB_CLIENT_ID`. Solo cubren github.com y gitlab.com: un GitLab propio o un
//! GitHub Enterprise tienen sus propias aplicaciones, así que ahí va token.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::provider::ForgeKind;
use super::secret::Secret;
use crate::util::now_ts;

/// La OAuth App "ControlCode" de GitHub (con Device Flow habilitado). Es una OAuth App y
/// no una GitHub App a propósito: la segunda da tokens de 8 h cuya renovación exige el
/// client secret —que en una app de escritorio no es secreto— y solo ve los repos donde
/// alguien la instaló.
const GITHUB_CLIENT_ID: &str = match option_env!("CC_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "Ov23liktZqGNLkFSEYsf",
};
/// La aplicación "ControlCode" de gitlab.com: no confidencial (sin secreto, que en una app
/// de escritorio no lo sería) y con "Device authorization grant" habilitado.
const GITLAB_CLIENT_ID: &str = match option_env!("CC_GITLAB_CLIENT_ID") {
    Some(id) => id,
    None => "3d90f6125fd6a917d0602f3dad40a369b45c7185df218aab2b9f12aa204184fb",
};

/// Lo que se pide. `repo` (GitHub) y `api` (GitLab) cubren repos privados, PRs e issues;
/// `write_repository` es lo que deja a git subir por HTTPS con un token de GitLab.
const GITHUB_SCOPES: &str = "repo read:org workflow";
const GITLAB_SCOPES: &str = "api read_user write_repository";

struct Endpoints {
    client_id: &'static str,
    device: &'static str,
    token: &'static str,
    scopes: &'static str,
}

fn endpoints(kind: ForgeKind, host: &str) -> Option<Endpoints> {
    match (kind, host) {
        (ForgeKind::Github, "github.com") if !GITHUB_CLIENT_ID.is_empty() => Some(Endpoints {
            client_id: GITHUB_CLIENT_ID,
            device: "https://github.com/login/device/code",
            token: "https://github.com/login/oauth/access_token",
            scopes: GITHUB_SCOPES,
        }),
        (ForgeKind::Gitlab, "gitlab.com") if !GITLAB_CLIENT_ID.is_empty() => Some(Endpoints {
            client_id: GITLAB_CLIENT_ID,
            device: "https://gitlab.com/oauth/authorize_device",
            token: "https://gitlab.com/oauth/token",
            scopes: GITLAB_SCOPES,
        }),
        _ => None,
    }
}

pub fn available(kind: ForgeKind, host: &str) -> bool {
    endpoints(kind, host).is_some()
}

struct Flow {
    kind: ForgeKind,
    host: String,
    device_code: String,
    interval: u64,
    expires_at: i64,
}

lazy_static::lazy_static! {
    static ref FLOWS: Mutex<HashMap<String, Flow>> = Mutex::new(HashMap::new());
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Con el código ya puesto, cuando el host lo ofrece (GitLab).
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

pub enum Poll {
    Pending { interval: u64 },
    Done { kind: ForgeKind, host: String, secret: Secret },
    Expired,
    Denied,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ControlCode")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

pub async fn start(kind: ForgeKind, host: &str) -> Result<DeviceStart, String> {
    let ep = endpoints(kind, host).ok_or("Este host no tiene inicio de sesión con navegador; usá un token")?;
    let res: Value = http()?
        .post(ep.device)
        .header("Accept", "application/json")
        .form(&[("client_id", ep.client_id), ("scope", ep.scopes)])
        .send()
        .await
        .map_err(|e| format!("No se pudo contactar a {host}: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let field = |k: &str| res.get(k).and_then(Value::as_str).map(str::to_string);
    let (Some(device_code), Some(user_code), Some(verification_uri)) =
        (field("device_code"), field("user_code"), field("verification_uri"))
    else {
        let why = field("error_description").or_else(|| field("error")).unwrap_or_else(|| res.to_string());
        return Err(format!("{host} rechazó el inicio de sesión: {why}"));
    };
    let expires_in = res.get("expires_in").and_then(Value::as_u64).unwrap_or(900);
    let interval = res.get("interval").and_then(Value::as_u64).unwrap_or(5).max(1);
    let flow_id = uuid::Uuid::new_v4().to_string();
    FLOWS.lock().unwrap().insert(
        flow_id.clone(),
        Flow { kind, host: host.to_string(), device_code, interval, expires_at: now_ts() + expires_in as i64 },
    );
    Ok(DeviceStart {
        flow_id,
        user_code,
        verification_uri,
        verification_uri_complete: field("verification_uri_complete"),
        expires_in,
        interval,
    })
}

/// Una pregunta: ¿ya autorizó? La UI la repite cada `interval` segundos.
pub async fn poll(flow_id: &str) -> Result<Poll, String> {
    let (kind, host, device_code, interval, expires_at) = {
        let flows = FLOWS.lock().unwrap();
        let f = flows.get(flow_id).ok_or("Este inicio de sesión ya no existe; empezá de nuevo")?;
        (f.kind, f.host.clone(), f.device_code.clone(), f.interval, f.expires_at)
    };
    if now_ts() > expires_at {
        FLOWS.lock().unwrap().remove(flow_id);
        return Ok(Poll::Expired);
    }
    let ep = endpoints(kind, &host).ok_or("Sin client ID")?;
    // Se lee el cuerpo sea cual sea el estado HTTP: GitHub contesta "pendiente" con 200 y
    // GitLab con 400, los dos con el mismo JSON.
    let res: Value = http()?
        .post(ep.token)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", ep.client_id),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(secret) = secret_from(&res) {
        FLOWS.lock().unwrap().remove(flow_id);
        return Ok(Poll::Done { kind, host, secret });
    }
    match res.get("error").and_then(Value::as_str).unwrap_or("") {
        "authorization_pending" => Ok(Poll::Pending { interval }),
        // El host pide más calma: se respeta, o termina cortando el flujo.
        "slow_down" => {
            let slower = interval + 5;
            if let Some(f) = FLOWS.lock().unwrap().get_mut(flow_id) {
                f.interval = slower;
            }
            Ok(Poll::Pending { interval: slower })
        }
        "expired_token" => {
            FLOWS.lock().unwrap().remove(flow_id);
            Ok(Poll::Expired)
        }
        "access_denied" => {
            FLOWS.lock().unwrap().remove(flow_id);
            Ok(Poll::Denied)
        }
        other => {
            FLOWS.lock().unwrap().remove(flow_id);
            let why = res.get("error_description").and_then(Value::as_str).unwrap_or(other);
            Err(format!("{host}: {why}"))
        }
    }
}

pub fn cancel(flow_id: &str) {
    FLOWS.lock().unwrap().remove(flow_id);
}

fn secret_from(res: &Value) -> Option<Secret> {
    let access_token = res.get("access_token").and_then(Value::as_str)?.to_string();
    Some(Secret {
        access_token,
        refresh_token: res.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        expires_at: res.get("expires_in").and_then(Value::as_i64).map(|s| now_ts() + s),
    })
}

/// Renueva un token que vence. Solo GitLab los da con vencimiento (2 h).
pub async fn refresh(kind: ForgeKind, host: &str, refresh_token: &str) -> Result<Secret, String> {
    let ep = endpoints(kind, host).ok_or("Sin client ID para renovar el token")?;
    let res: Value = http()?
        .post(ep.token)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", ep.client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    secret_from(&res).ok_or_else(|| "La sesión venció; volvé a iniciar sesión".to_string())
}
