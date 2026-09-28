//! Notificaciones al teléfono cuando no está conectado.
//!
//! Van por el servicio de Expo, que las entrega por APNs (iOS) o FCM (Android). El texto
//! es genérico a propósito: una notificación pasa por los servidores de Expo, Apple o
//! Google, y lo que el agente quiere hacer solo viaja cifrado por el relay. Al tocarla, el
//! teléfono abre la app y lo ve ahí.

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::database::DbConnection;

const EXPO_PUSH: &str = "https://exp.host/--/api/v2/push/send";

/// Avisa a los teléfonos emparejados que no están conectados ahora.
pub fn notify_offline(app: &AppHandle, title: &str, body: &str) {
    let Some(db) = app.try_state::<DbConnection>() else { return };
    if !super::config::load(&db).enabled {
        return;
    }
    let online = super::client::online_ids();
    let tokens: Vec<String> = {
        let Ok(conn) = db.lock() else { return };
        super::devices::list(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|d| !online.contains(&d.id))
            .filter_map(|d| d.push_token)
            .collect()
    };
    if tokens.is_empty() {
        return;
    }
    let messages: Vec<_> = tokens
        .iter()
        .map(|to| json!({ "to": to, "title": title, "body": body, "sound": "default", "priority": "high" }))
        .collect();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        match client.post(EXPO_PUSH).json(&messages).send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => eprintln!("[remote] el servicio de notificaciones contestó {}", r.status()),
            Err(e) => eprintln!("[remote] no se pudo mandar la notificación: {e}"),
        }
    });
}
