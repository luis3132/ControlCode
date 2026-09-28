//! Tests del control remoto: las piezas puras, y la conexión entera contra un relay de
//! verdad con un "teléfono" de prueba del otro lado.

use super::{config, devices, handlers, live, pairing};
use controlcode_relay::crypto::Keypair;
use controlcode_relay::protocol::{self, ClientFrame, Inner, Role, ServerFrame};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn la_direccion_del_relay_se_escribe_como_sea() {
    assert_eq!(config::ws_url("relay.casa.com").unwrap(), "wss://relay.casa.com/v1/ws");
    assert_eq!(config::ws_url("https://relay.casa.com/").unwrap(), "wss://relay.casa.com/v1/ws");
    assert_eq!(config::ws_url("ws://192.168.1.5:8787").unwrap(), "ws://192.168.1.5:8787/v1/ws");
    assert_eq!(config::ws_url("wss://x.com/otra/ruta").unwrap(), "wss://x.com/otra/ruta");
    assert!(config::ws_url("").is_err());
    assert!(config::ws_url("ftp://x").is_err());
    assert_eq!(config::base_url("https://relay.casa.com").unwrap(), "wss://relay.casa.com");
}

#[test]
fn emparejar_y_olvidar_un_telefono() {
    let db = crate::database::test_db();
    devices::upsert(&db, "k1", "iPhone\nde Luis", Some("ios"), None).unwrap();
    // Volver a escanear actualiza el nombre sin perder el token de push que ya tenía.
    devices::set_push_token(&db, "k1", Some("ExponentPushToken[x]")).unwrap();
    devices::upsert(&db, "k1", "iPhone", Some("ios"), None).unwrap();
    let list = devices::list(&db).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "iPhone");
    assert!(list[0].has_push);
    // Un nombre de afuera no trae saltos de línea.
    devices::upsert(&db, "k2", "a\nb", None, None).unwrap();
    assert_eq!(devices::list(&db).unwrap()[1].name, "ab");
    devices::remove(&db, "k1").unwrap();
    assert_eq!(devices::list(&db).unwrap().len(), 1);
}

/// El secreto del QR sirve una sola vez, y solo el último que se mostró.
#[test]
fn el_qr_es_de_un_solo_uso() {
    let first = pairing::start();
    let second = pairing::start();
    assert!(!pairing::consume(&first), "un QR viejo ya no vale");
    assert!(!pairing::consume("basura"));
    assert!(pairing::consume(&second));
    assert!(!pairing::consume(&second), "ni dos veces el mismo");
    let svg = pairing::qr_svg(r#"{"v":1}"#).unwrap();
    assert!(svg.starts_with("<?xml") || svg.contains("<svg"));
}

/// Un carácter partido entre dos lecturas del PTY no se rompe: su mitad espera la otra.
#[test]
fn la_salida_no_parte_caracteres() {
    let text = "ñandú ✓";
    let bytes = text.as_bytes();
    let mut buf = bytes[..bytes.len() - 1].to_vec();
    let first = live::take_text(&mut buf);
    assert_eq!(first, "ñandú ");
    assert_eq!(buf.len(), 2, "lo incompleto queda para después");
    buf.extend_from_slice(&bytes[bytes.len() - 1..]);
    assert_eq!(live::take_text(&mut buf), "✓");

    let long = "á".repeat(10);
    let parts = live::chunks(&long, 5);
    assert!(parts.iter().all(|p| p.len() <= 5));
    assert_eq!(parts.concat(), long);
    assert_eq!(handlers::tail("ñandú", 3), "dú");
}

// ── La conexión entera ───────────────────────────────────────────

/// Un `Host` de prueba: un teléfono emparejado y un registro de lo que se le pidió.
struct FakeHost {
    paired: Mutex<Vec<String>>,
    calls: Mutex<Vec<(String, String)>>,
}

impl super::client::Host for FakeHost {
    fn paired(&self) -> Vec<String> {
        self.paired.lock().unwrap().clone()
    }
    fn handle(&self, from: &str, method: &str, _params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push((from.into(), method.into()));
        match method {
            "pair" => {
                self.paired.lock().unwrap().push(from.into());
                super::client::rewatch(self.paired());
                Ok(json!({ "name": "PC de prueba" }))
            }
            "state" => Ok(json!({ "tabs": [] })),
            _ => Err("no".into()),
        }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn recv(ws: &mut Ws) -> ServerFrame {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timeout").unwrap().unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}

async fn send(ws: &mut Ws, frame: &ClientFrame) {
    ws.send(Message::Text(serde_json::to_string(frame).unwrap().into())).await.unwrap();
}

/// Espera la respuesta a `request` (salteando presencia y eventos).
async fn response(ws: &mut Ws, phone: &Keypair, pc: &str, request: &Inner) -> Inner {
    loop {
        if let ServerFrame::Msg { from, body } = recv(ws).await {
            assert_eq!(from, pc);
            let msg = Inner::open(&body, &from, phone).unwrap();
            if matches!(&msg, Inner::Res { id, .. } if id == request.id()) {
                return msg;
            }
        }
    }
}

#[tokio::test]
async fn un_telefono_se_empareja_y_pide_por_el_relay() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/ws", listener.local_addr().unwrap());
    tokio::spawn(controlcode_relay::server::serve(listener, controlcode_relay::server::Config { token: Some("tk".into()) }));

    let pc = Keypair::generate();
    let host = Arc::new(FakeHost { paired: Mutex::new(Vec::new()), calls: Mutex::new(Vec::new()) });
    let dyn_host: Arc<dyn super::client::Host> = host.clone();
    tokio::spawn(super::client::run_forever(url.clone(), Some("tk".into()), pc.clone(), dyn_host));
    for _ in 0..50 {
        if super::client::status().state == "connected" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(super::client::status().state, "connected");

    // El teléfono.
    let phone = Keypair::generate();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let ServerFrame::Challenge { relay, challenge } = recv(&mut ws).await else { panic!() };
    send(&mut ws, &protocol::hello(&phone, Role::Device, &relay, &challenge, Some("tk".into())).unwrap()).await;
    assert!(matches!(recv(&mut ws).await, ServerFrame::Ready { .. }));

    // Sin emparejar, lo que pida se descarta en silencio.
    let state = Inner::req("state", json!({}));
    send(&mut ws, &ClientFrame::Send { to: pc.id(), body: state.seal(&pc.id(), &phone).unwrap() }).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(host.calls.lock().unwrap().is_empty(), "un desconocido no llega al handler");

    // Emparejarse sí se atiende.
    let pair = Inner::req("pair", json!({ "secret": "x", "name": "Test" }));
    send(&mut ws, &ClientFrame::Send { to: pc.id(), body: pair.seal(&pc.id(), &phone).unwrap() }).await;
    let Inner::Res { ok, r, .. } = response(&mut ws, &phone, &pc.id(), &pair).await else { panic!() };
    assert!(ok);
    assert_eq!(r.unwrap()["name"], "PC de prueba");

    // Ya emparejado: el PC lo observa y lo ve conectado.
    for _ in 0..50 {
        if super::client::online_ids().contains(&phone.id()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(super::client::online_ids().contains(&phone.id()));

    let state = Inner::req("state", json!({}));
    let body = state.seal(&pc.id(), &phone).unwrap();
    send(&mut ws, &ClientFrame::Send { to: pc.id(), body: body.clone() }).await;
    let Inner::Res { ok, .. } = response(&mut ws, &phone, &pc.id(), &state).await else { panic!() };
    assert!(ok);

    // El mismo mensaje repetido (el relay podría reenviarlo) no se atiende de nuevo.
    let before = host.calls.lock().unwrap().len();
    send(&mut ws, &ClientFrame::Send { to: pc.id(), body }).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.calls.lock().unwrap().len(), before);

    // Los eventos del PC le llegan.
    super::client::broadcast("approvals", json!({ "list": [] }));
    loop {
        if let ServerFrame::Msg { from, body } = recv(&mut ws).await {
            if let Inner::Evt { e, .. } = Inner::open(&body, &from, &phone).unwrap() {
                assert_eq!(e, "approvals");
                break;
            }
        }
    }

    // Se va: el PC deja de verlo.
    ws.close(None).await.unwrap();
    for _ in 0..50 {
        if !super::client::online_ids().contains(&phone.id()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!super::client::online_ids().contains(&phone.id()));
}
