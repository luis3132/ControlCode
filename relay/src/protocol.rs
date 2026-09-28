//! Los mensajes. Ver `docs/remote-protocol.md`.
//!
//! Dos capas:
//! - [`ClientFrame`] / [`ServerFrame`]: lo que ve el relay. Solo rutea.
//! - [`Inner`]: lo que va cifrado adentro de `body`, entre el PC y el móvil.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::crypto::{self, Keypair, b64, public_key, unb64};

/// Versión del protocolo. Va en el QR de emparejamiento.
pub const VERSION: u32 = 1;

/// Tope de un frame, en bytes.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Desktop,
    Device,
}

/// Cliente → relay.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientFrame {
    Hello {
        role: Role,
        key: String,
        proof: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    Send { to: String, body: String },
    Watch { ids: Vec<String> },
}

/// Relay → cliente.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerFrame {
    Challenge { relay: String, challenge: String },
    Ready { id: String },
    Error { code: String, message: String },
    Msg { from: String, body: String },
    Undelivered { to: String },
    Presence { id: String, online: bool },
}

impl ServerFrame {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerFrame::Error { code: code.into(), message: message.into() }
    }
}

/// El `hello` que contesta a un `challenge`: prueba que tenemos la clave secreta.
pub fn hello(keys: &Keypair, role: Role, relay: &str, challenge: &str, token: Option<String>) -> Result<ClientFrame, String> {
    let relay_pk = public_key(relay)?;
    let challenge = unb64(challenge)?;
    Ok(ClientFrame::Hello {
        role,
        key: keys.id(),
        proof: b64(&crypto::seal(&challenge, &relay_pk, &keys.secret)),
        token,
    })
}

/// Lo que viaja cifrado entre el PC y el móvil.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Inner {
    Req {
        id: String,
        ts: i64,
        m: String,
        #[serde(default)]
        p: Value,
    },
    Res {
        id: String,
        ts: i64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        e: Option<String>,
    },
    Evt {
        id: String,
        ts: i64,
        e: String,
        #[serde(default)]
        d: Value,
    },
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Inner {
    pub fn req(method: &str, params: Value) -> Self {
        Inner::Req { id: new_id(), ts: now_ms(), m: method.into(), p: params }
    }

    pub fn ok(request_id: &str, result: Value) -> Self {
        Inner::Res { id: request_id.into(), ts: now_ms(), ok: true, r: Some(result), e: None }
    }

    pub fn err(request_id: &str, message: impl Into<String>) -> Self {
        Inner::Res { id: request_id.into(), ts: now_ms(), ok: false, r: None, e: Some(message.into()) }
    }

    pub fn evt(name: &str, data: Value) -> Self {
        Inner::Evt { id: new_id(), ts: now_ms(), e: name.into(), d: data }
    }

    pub fn id(&self) -> &str {
        match self {
            Inner::Req { id, .. } | Inner::Res { id, .. } | Inner::Evt { id, .. } => id,
        }
    }

    pub fn ts(&self) -> i64 {
        match self {
            Inner::Req { ts, .. } | Inner::Res { ts, .. } | Inner::Evt { ts, .. } => *ts,
        }
    }

    /// Cifrado para `peer`, listo para el `body` de un `send`.
    pub fn seal(&self, peer: &str, keys: &Keypair) -> Result<String, String> {
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        Ok(b64(&crypto::seal(&json, &public_key(peer)?, &keys.secret)))
    }

    /// Abre el `body` de un `msg` que dice venir de `from`.
    pub fn open(body: &str, from: &str, keys: &Keypair) -> Result<Self, String> {
        let plain = crypto::open(&unb64(body)?, &public_key(from)?, &keys.secret)?;
        serde_json::from_slice(&plain).map_err(|e| format!("mensaje ilegible: {e}"))
    }
}

/// Lo que va en el QR de emparejamiento.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PairingCode {
    pub v: u32,
    pub relay: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub desktop: String,
    pub name: String,
    pub secret: String,
}

/// Cuánto puede diferir el reloj de quien manda del de quien recibe.
pub const MAX_SKEW_MS: i64 = 5 * 60 * 1000;
/// Cuánto se recuerdan los ids ya vistos. Más que `MAX_SKEW_MS` a los dos lados: un
/// mensaje repetido después de eso ya lo rechaza la fecha.
pub const SEEN_TTL_MS: i64 = 11 * 60 * 1000;

/// Rechaza mensajes viejos o repetidos: el relay no puede leerlos, pero sí podría volver
/// a mandar un "aprobar" que ya pasó.
#[derive(Default)]
pub struct ReplayGuard {
    seen: HashMap<String, i64>,
}

impl ReplayGuard {
    /// `Ok` si el mensaje es nuevo (y lo anota); `Err` con el motivo si no.
    pub fn check(&mut self, msg: &Inner, now: i64) -> Result<(), &'static str> {
        if (now - msg.ts()).abs() > MAX_SKEW_MS {
            return Err("fuera de hora");
        }
        self.seen.retain(|_, at| now - *at < SEEN_TTL_MS);
        if self.seen.contains_key(msg.id()) {
            return Err("repetido");
        }
        self.seen.insert(msg.id().to_string(), now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn el_formato_en_el_cable_es_el_documentado() {
        let f = ClientFrame::Send { to: "a".into(), body: "b".into() };
        assert_eq!(serde_json::to_value(&f).unwrap(), json!({ "t": "send", "to": "a", "body": "b" }));
        let f = ServerFrame::Presence { id: "a".into(), online: true };
        assert_eq!(serde_json::to_value(&f).unwrap(), json!({ "t": "presence", "id": "a", "online": true }));
        let hello: ClientFrame =
            serde_json::from_value(json!({ "t": "hello", "role": "device", "key": "k", "proof": "p" })).unwrap();
        assert!(matches!(hello, ClientFrame::Hello { role: Role::Device, token: None, .. }));
        let res = Inner::ok("x", json!({ "a": 1 }));
        let v = serde_json::to_value(&res).unwrap();
        assert_eq!(v["k"], "res");
        assert_eq!(v["ok"], true);
        assert!(v.get("e").is_none());
    }

    #[test]
    fn un_mensaje_cifrado_solo_lo_abre_su_destinatario() {
        let (pc, phone, other) = (Keypair::generate(), Keypair::generate(), Keypair::generate());
        let msg = Inner::req("state", json!({}));
        let body = msg.seal(&phone.id(), &pc).unwrap();
        assert_eq!(Inner::open(&body, &pc.id(), &phone).unwrap(), msg);
        // Otro no puede, y tampoco sirve decir que viene de otro lado.
        assert!(Inner::open(&body, &pc.id(), &other).is_err());
        assert!(Inner::open(&body, &other.id(), &phone).is_err());
    }

    #[test]
    fn lo_viejo_y_lo_repetido_se_rechaza() {
        let mut guard = ReplayGuard::default();
        let msg = Inner::req("approval.decide", json!({}));
        let now = msg.ts();
        assert!(guard.check(&msg, now).is_ok());
        assert_eq!(guard.check(&msg, now + 1000), Err("repetido"));
        let old = Inner::Req { id: "otro".into(), ts: now - MAX_SKEW_MS - 1, m: "x".into(), p: json!({}) };
        assert_eq!(guard.check(&old, now), Err("fuera de hora"));
    }
}
