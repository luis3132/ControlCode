//! El relay de verdad, en un puerto libre, con clientes WebSocket de verdad.

use controlcode_relay::crypto::{Keypair, b64};
use controlcode_relay::protocol::{ClientFrame, Inner, Role, ServerFrame, hello};
use controlcode_relay::server::{Config, serve};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start(config: Config) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(listener, config));
    format!("ws://{addr}/v1/ws")
}

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

/// Conecta y se autentica. Devuelve el socket ya listo.
async fn connect(url: &str, keys: &Keypair, role: Role, token: Option<&str>) -> Result<Ws, ServerFrame> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let ServerFrame::Challenge { relay, challenge } = recv(&mut ws).await else { panic!("sin challenge") };
    send(&mut ws, &hello(keys, role, &relay, &challenge, token.map(str::to_string)).unwrap()).await;
    match recv(&mut ws).await {
        ServerFrame::Ready { id } => {
            assert_eq!(id, keys.id());
            Ok(ws)
        }
        other => Err(other),
    }
}

#[tokio::test]
async fn un_mensaje_cifrado_va_del_movil_al_pc_y_vuelve() {
    let url = start(Config::default()).await;
    let (pc_keys, phone_keys) = (Keypair::generate(), Keypair::generate());
    let mut pc = connect(&url, &pc_keys, Role::Desktop, None).await.unwrap();
    let mut phone = connect(&url, &phone_keys, Role::Device, None).await.unwrap();

    let req = Inner::req("state", json!({}));
    send(&mut phone, &ClientFrame::Send { to: pc_keys.id(), body: req.seal(&pc_keys.id(), &phone_keys).unwrap() }).await;

    let ServerFrame::Msg { from, body } = recv(&mut pc).await else { panic!() };
    assert_eq!(from, phone_keys.id());
    let got = Inner::open(&body, &from, &pc_keys).unwrap();
    assert_eq!(got, req);

    let res = Inner::ok(req.id(), json!({ "name": "PC" }));
    send(&mut pc, &ClientFrame::Send { to: from.clone(), body: res.seal(&from, &pc_keys).unwrap() }).await;
    let ServerFrame::Msg { body, .. } = recv(&mut phone).await else { panic!() };
    assert_eq!(Inner::open(&body, &pc_keys.id(), &phone_keys).unwrap(), res);
}

/// Sin la clave secreta no hay forma de presentarse como otro: el `proof` no abriría.
#[tokio::test]
async fn nadie_se_hace_pasar_por_otra_clave() {
    let url = start(Config::default()).await;
    let (victim, attacker) = (Keypair::generate(), Keypair::generate());
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let ServerFrame::Challenge { relay, challenge } = recv(&mut ws).await else { panic!() };
    // La prueba la arma el atacante con SU clave, pero dice ser la víctima.
    let ClientFrame::Hello { proof, .. } = hello(&attacker, Role::Desktop, &relay, &challenge, None).unwrap() else { panic!() };
    send(&mut ws, &ClientFrame::Hello { role: Role::Desktop, key: victim.id(), proof, token: None }).await;
    assert!(matches!(recv(&mut ws).await, ServerFrame::Error { code, .. } if code == "auth"));
}

#[tokio::test]
async fn con_token_solo_entra_quien_lo_tiene() {
    let url = start(Config { token: Some("secreto".into()) }).await;
    let keys = Keypair::generate();
    let err = connect(&url, &keys, Role::Device, None).await.err().unwrap();
    assert!(matches!(err, ServerFrame::Error { code, .. } if code == "token"));
    let err = connect(&url, &keys, Role::Device, Some("otro")).await.err().unwrap();
    assert!(matches!(err, ServerFrame::Error { code, .. } if code == "token"));
    assert!(connect(&url, &keys, Role::Device, Some("secreto")).await.is_ok());
}

#[tokio::test]
async fn a_quien_no_esta_conectado_no_se_le_encola_nada() {
    let url = start(Config::default()).await;
    let keys = Keypair::generate();
    let mut ws = connect(&url, &keys, Role::Device, None).await.unwrap();
    let absent = b64(&[7u8; 32]);
    send(&mut ws, &ClientFrame::Send { to: absent.clone(), body: "x".into() }).await;
    assert_eq!(recv(&mut ws).await, ServerFrame::Undelivered { to: absent });
}

/// El móvil observa al PC: sabe si está conectado ahora y se entera cuando cambia. Así el
/// PC decide si mandar una notificación push.
#[tokio::test]
async fn presencia_al_pedirla_y_en_cada_cambio() {
    let url = start(Config::default()).await;
    let (pc_keys, phone_keys) = (Keypair::generate(), Keypair::generate());
    let mut phone = connect(&url, &phone_keys, Role::Device, None).await.unwrap();
    send(&mut phone, &ClientFrame::Watch { ids: vec![pc_keys.id()] }).await;
    assert_eq!(recv(&mut phone).await, ServerFrame::Presence { id: pc_keys.id(), online: false });

    let mut pc = connect(&url, &pc_keys, Role::Desktop, None).await.unwrap();
    assert_eq!(recv(&mut phone).await, ServerFrame::Presence { id: pc_keys.id(), online: true });

    // Una segunda conexión del mismo PC no es un cambio; cerrar la primera tampoco.
    let second = connect(&url, &pc_keys, Role::Desktop, None).await.unwrap();
    pc.close(None).await.unwrap();
    drop(pc);
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(second);
    assert_eq!(recv(&mut phone).await, ServerFrame::Presence { id: pc_keys.id(), online: false });
}

#[tokio::test]
async fn health() {
    let url = start(Config::default()).await;
    let http = url.replace("ws://", "").replace("/v1/ws", "");
    let mut stream = tokio::net::TcpStream::connect(&http).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200") && out.ends_with("ok"), "{out}");
}
