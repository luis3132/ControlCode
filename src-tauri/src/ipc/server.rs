//! Servidor IPC: escucha en loopback y despacha cada request a `commands`.
//!
//! Ver `protocol.rs` para el formato del mensaje y el modelo de autorización.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use tauri::AppHandle;
use uuid::Uuid;

use super::commands;
use super::protocol::{handshake_path, Handshake, Request, Response, PROTOCOL_VERSION};

/// Levanta el servidor en un thread propio y publica el archivo de handshake.
///
/// Un fallo acá no debe impedir que la app arranque: sin servidor IPC se pierde la CLI,
/// pero la app en sí sigue siendo perfectamente usable.
pub fn start(app: AppHandle) {
    if let Err(e) = try_start(app) {
        eprintln!("[controlcode] no se pudo iniciar el servidor IPC: {e}");
    }
}

fn try_start(app: AppHandle) -> Result<(), String> {
    // Puerto 0 = el SO elige uno libre. Atarse a un puerto fijo haría que dos instancias
    // (o cualquier otro programa que ya lo tuviera) se pisaran.
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = Uuid::new_v4().to_string();

    write_handshake(&Handshake {
        port,
        token: token.clone(),
        pid: std::process::id(),
        protocol: PROTOCOL_VERSION,
    })?;

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = token.clone();
            // Un cliente lento (o que abre la conexión y no manda nada) no debe bloquear
            // a los demás, así que cada conexión se atiende en su propio thread.
            std::thread::spawn(move || handle_connection(stream, &app, &token));
        }
    });

    Ok(())
}

/// Escribe el handshake con permisos restringidos al usuario: el token que contiene ES
/// la credencial, y en un `$HOME` compartido cualquier otra cuenta podría leerlo.
fn write_handshake(handshake: &Handshake) -> Result<(), String> {
    let path = handshake_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(handshake).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Borra el archivo de handshake. Se llama al salir para no dejar apuntando a un puerto
/// que ya no escucha nadie.
pub fn cleanup() {
    let _ = std::fs::remove_file(handshake_path());
}

fn handle_connection(stream: TcpStream, app: &AppHandle, expected_token: &str) {
    // Sin timeout, una conexión que nunca manda una línea completa deja el thread colgado
    // para siempre.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));

    let Ok(write_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;

    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
        return;
    }

    let mut command = String::new();
    let response = match serde_json::from_str::<Request>(&line) {
        Err(e) => Response::err(format!("Request inválida: {e}")),
        Ok(req) if req.token != expected_token => {
            Response::err("Token inválido — volvé a leer ~/.controlcode/ipc.json")
        }
        Ok(req) => {
            command = req.command.clone();
            commands::dispatch(app, &req.command, &req.args)
        }
    };

    if let Ok(json) = serde_json::to_string(&response) {
        // Fase 9: se contabiliza lo que la CLI se lleva de verdad — el JSON ya serializado,
        // no una estimación de antes de armarlo. Es el número que ve el usuario en el
        // indicador de la UI. Las requests rechazadas (token inválido) no cuentan: no
        // salieron de ningún orquestador nuestro.
        if !command.is_empty() {
            crate::orchestrator::record_response(app, &command, &json);
        }
        let _ = writeln!(writer, "{json}");
        let _ = writer.flush();
    }
}
