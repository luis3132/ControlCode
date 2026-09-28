//! Lo que usa la sección Configuración → Móvil.

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::client::{self, Status};
use super::config::{self, RemoteConfig};
use super::{devices, live, pairing};
use crate::database::DbConnection;
use controlcode_relay::protocol::{PairingCode, VERSION};

#[tauri::command]
pub fn remote_get_config(db: tauri::State<DbConnection>) -> RemoteConfig {
    config::load(&db)
}

/// Guarda y reconecta con lo nuevo.
#[tauri::command]
pub fn remote_save_config(app: AppHandle, config: RemoteConfig, db: tauri::State<DbConnection>) -> Result<(), String> {
    config::save(&db, &config)?;
    client::start(&app);
    Ok(())
}

#[tauri::command]
pub fn remote_status() -> Status {
    client::status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// El QR, como SVG.
    pub svg: String,
    /// El mismo contenido en texto, para pegarlo a mano si la cámara no anda.
    pub code: String,
    pub expires_in_secs: u64,
}

/// Un QR nuevo para emparejar un teléfono. Hace falta estar conectado al relay: es por
/// ahí que el teléfono va a escribir.
#[tauri::command]
pub fn remote_start_pairing(db: tauri::State<DbConnection>) -> Result<PairingView, String> {
    let config = config::load(&db);
    if !config.enabled {
        return Err("Activá el control remoto primero".into());
    }
    let keys = client::keys().ok_or("Todavía no hay conexión con el relay")?;
    let code = PairingCode {
        v: VERSION,
        relay: config::base_url(&config.relay_url)?,
        token: config.token.clone(),
        desktop: keys.id(),
        name: config.name.clone(),
        secret: pairing::start(),
    };
    let code = serde_json::to_string(&code).map_err(|e| e.to_string())?;
    Ok(PairingView { svg: pairing::qr_svg(&code)?, code, expires_in_secs: pairing::TTL.as_secs() })
}

#[tauri::command]
pub fn remote_cancel_pairing() {
    pairing::cancel();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    #[serde(flatten)]
    pub device: devices::Device,
    pub online: bool,
}

#[tauri::command]
pub fn remote_devices(db: tauri::State<DbConnection>) -> Result<Vec<DeviceView>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let online = client::online_ids();
    Ok(devices::list(&conn)?
        .into_iter()
        .map(|d| DeviceView { online: online.contains(&d.id), device: d })
        .collect())
}

/// Olvida un teléfono: deja de poder hablar con este equipo hasta que se empareje de nuevo.
#[tauri::command]
pub fn remote_remove_device(app: AppHandle, id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let ids = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        devices::remove(&conn, &id)?;
        devices::list(&conn)?.into_iter().map(|d| d.id).collect()
    };
    live::unsubscribe(&id, None);
    client::rewatch(ids);
    let _ = app.emit("remote-devices", json!({}));
    Ok(())
}
