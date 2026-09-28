//! El QR de emparejamiento: un secreto de un solo uso que vence a los 5 minutos.
//!
//! El QR le da al teléfono la clave pública de este equipo por un canal que el relay no ve
//! (la pantalla), así el relay no puede hacerse pasar por el PC. Y el secreto prueba ante
//! el PC que quien pide emparejarse es quien escaneó el QR.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use controlcode_relay::crypto::{self, b64, unb64};

pub const TTL: Duration = Duration::from_secs(5 * 60);

lazy_static::lazy_static! {
    static ref SLOT: Mutex<Option<([u8; 32], Instant)>> = Mutex::new(None);
}

/// Un secreto nuevo. Invalida el anterior: solo vale el último QR mostrado.
pub fn start() -> String {
    let secret: [u8; 32] = crypto::random_bytes();
    *SLOT.lock().unwrap_or_else(|e| e.into_inner()) = Some((secret, Instant::now() + TTL));
    b64(&secret)
}

/// Deja de aceptar el QR que se estaba mostrando.
pub fn cancel() {
    *SLOT.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Si el secreto es el del QR vigente. Se consume: un segundo intento con el mismo falla.
pub fn consume(given: &str) -> bool {
    let Ok(given) = unb64(given) else { return false };
    let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    match *slot {
        Some((secret, expires)) if Instant::now() < expires && crypto::constant_time_eq(&secret, &given) => {
            *slot = None;
            true
        }
        _ => false,
    }
}

/// El QR como SVG, para mostrarlo tal cual.
pub fn qr_svg(content: &str) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(content.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
}
