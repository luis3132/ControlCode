//! Un "PC" mínimo en Rust, para probar la app móvil (TypeScript) contra el protocolo de
//! verdad: se conecta al relay como `desktop`, contesta cada pedido con lo que recibió y
//! manda un evento. Lo usa `mobile/src/protocol/tests/interop.test.ts`.
//!
//! ```text
//! cargo run --example echo_desktop -- ws://127.0.0.1:8787/v1/ws
//! ```
//!
//! Imprime `READY <id>` cuando está conectado.

use controlcode_relay::crypto::Keypair;
use controlcode_relay::protocol::{self, ClientFrame, Inner, Role, ServerFrame};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn text(frame: &ClientFrame) -> Message {
    Message::Text(serde_json::to_string(frame).unwrap().into())
}

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).expect("falta la URL del relay");
    let keys = Keypair::generate();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.expect("conectar");

    let mut next = async || -> ServerFrame {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    };
    let ServerFrame::Challenge { relay, challenge } = next().await else { panic!("sin desafío") };
    drop(next);
    ws.send(text(&protocol::hello(&keys, Role::Desktop, &relay, &challenge, None).unwrap())).await.unwrap();

    let mut guard = protocol::ReplayGuard::default();
    while let Some(Ok(msg)) = ws.next().await {
        let Message::Text(t) = msg else { continue };
        match serde_json::from_str::<ServerFrame>(t.as_str()).unwrap() {
            ServerFrame::Ready { id } => println!("READY {id}"),
            ServerFrame::Msg { from, body } => {
                let Ok(inner) = Inner::open(&body, &from, &keys) else { continue };
                if guard.check(&inner, protocol::now_ms()).is_err() {
                    continue;
                }
                if let Inner::Req { id, m, p, .. } = inner {
                    let reply = Inner::ok(&id, json!({ "method": m, "params": p }));
                    ws.send(text(&ClientFrame::Send { to: from.clone(), body: reply.seal(&from, &keys).unwrap() })).await.unwrap();
                    let evt = Inner::evt("approvals", json!({ "list": [{ "id": "a1", "toolName": "Bash" }] }));
                    ws.send(text(&ClientFrame::Send { to: from.clone(), body: evt.seal(&from, &keys).unwrap() })).await.unwrap();
                }
            }
            _ => {}
        }
    }
}
