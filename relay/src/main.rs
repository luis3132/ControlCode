//! `controlcode-relay`: el servidor auto-alojado entre Control Code y su app móvil.
//!
//! ```text
//! controlcode-relay [--addr 0.0.0.0:8787] [--token <secreto>]
//! ```
//!
//! También por entorno: `CC_RELAY_ADDR` y `CC_RELAY_TOKEN`. Sin token, cualquiera que
//! conozca la dirección puede conectarse (aunque no pueda leer nada: todo va cifrado de
//! punta a punta); con token, solo quien lo tenga. TLS lo pone un proxy delante (Caddy,
//! nginx, Traefik): ver `relay/README.md`.

use controlcode_relay::server::{Config, serve};

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("controlcode-relay [--addr 0.0.0.0:8787] [--token <secreto>]\n\nEntorno: CC_RELAY_ADDR, CC_RELAY_TOKEN");
        return std::process::ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("controlcode-relay {}", env!("CARGO_PKG_VERSION"));
        return std::process::ExitCode::SUCCESS;
    }

    let addr = arg(&args, "--addr")
        .or_else(|| std::env::var("CC_RELAY_ADDR").ok())
        .unwrap_or_else(|| "0.0.0.0:8787".into());
    let token = arg(&args, "--token")
        .or_else(|| std::env::var("CC_RELAY_TOKEN").ok())
        .filter(|t| !t.trim().is_empty());

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("no se pudo escuchar en {addr}: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    eprintln!(
        "controlcode-relay {} escuchando en {addr} ({})",
        env!("CARGO_PKG_VERSION"),
        if token.is_some() { "con token" } else { "SIN token: cualquiera puede conectarse" }
    );
    match serve(listener, Config { token }).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("el relay se detuvo: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
