//! Vectores fijos de `crypto_box`: los mismos que verifica la app móvil con `tweetnacl`
//! (`mobile/src/protocol/tests`). Si una de las dos implementaciones cambiara de
//! construcción, uno de los dos tests se rompe.
//!
//! Para regenerarlos (solo si cambia el protocolo a propósito):
//! `CC_WRITE_VECTORS=1 cargo test --test vectors`

use controlcode_relay::crypto::{self, Keypair, b64, unb64};
use serde_json::{Value, json};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");

fn keys(seed: u8) -> Keypair {
    Keypair::from_secret([seed; 32])
}

fn generate() -> Value {
    let (a, b) = (keys(1), keys(2));
    let cases: Vec<Value> = ["", "hola", r#"{"k":"req","id":"1","ts":0,"m":"state","p":{}}"#]
        .iter()
        .enumerate()
        .map(|(i, msg)| {
            let nonce = [i as u8 + 9; crypto::NONCE_LEN];
            json!({
                "message": msg,
                "nonce": b64(&nonce),
                "sealed": b64(&crypto::seal_with_nonce(msg.as_bytes(), &nonce, &b.public, &a.secret)),
            })
        })
        .collect();
    json!({
        "comment": "sealed = nonce ‖ crypto_box(message, nonce, recipient.public, sender.secret); base64url sin padding",
        "sender": { "secret": b64(&a.secret), "public": b64(&a.public) },
        "recipient": { "secret": b64(&b.secret), "public": b64(&b.public) },
        "cases": cases,
    })
}

#[test]
fn los_vectores_siguen_valiendo() {
    let fresh = generate();
    if std::env::var_os("CC_WRITE_VECTORS").is_some() {
        std::fs::write(PATH, serde_json::to_string_pretty(&fresh).unwrap() + "\n").unwrap();
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert_eq!(stored, fresh);

    // Y se abren con la clave del destinatario.
    let (a, b) = (keys(1), keys(2));
    for case in stored["cases"].as_array().unwrap() {
        let sealed = unb64(case["sealed"].as_str().unwrap()).unwrap();
        let plain = crypto::open(&sealed, &a.public, &b.secret).unwrap();
        assert_eq!(String::from_utf8(plain).unwrap(), case["message"].as_str().unwrap());
    }
}
