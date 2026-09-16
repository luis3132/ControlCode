//! Respuestas simuladas: que el servidor del proyecto conteste otra cosa para una URL, sin
//! tocar el código.
//!
//! Es lo que hace posible probar lo que casi nunca se puede provocar a mano: un 500 del
//! endpoint de login, una lista vacía, una respuesta que tarda cinco segundos. Va en el
//! proxy y no en la página porque así vale para todo lo que el navegador pida —fetch, XHR,
//! una imagen, el HTML mismo— y no depende de que la página use una API concreta.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

/// Cuántas reglas se guardan. Son de una sesión de prueba, no una configuración.
const MAX_MOCKS: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mock {
    #[serde(default)]
    pub id: String,
    /// `GET`, `POST`… `None` = cualquiera.
    #[serde(default)]
    pub method: Option<String>,
    /// Parte de la URL, con `*` como comodín: `/api/login`, `*/users?*`.
    pub url: String,
    #[serde(default = "default_status")]
    pub status: u16,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub content_type: Option<String>,
    /// Cuánto tarda en contestar, para probar lo lento.
    #[serde(default)]
    pub delay_ms: u64,
    /// Cuántas veces vale. `None` = siempre.
    #[serde(default)]
    pub times: Option<u32>,
    /// Cuántas veces se usó.
    #[serde(default)]
    pub hits: u32,
}

fn default_status() -> u16 {
    200
}

/// `*/api/*` contra `/api/login?x=1`. Sin regex: lo que se escribe a mano es un pedazo de
/// URL con comodines, y una regex mal escrita fallaría en silencio.
pub fn matches(pattern: &str, url: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if !pattern.contains('*') {
        return url.contains(pattern);
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = url;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match rest.find(part) {
            // El primer trozo, si el patrón no arranca con `*`, tiene que estar al principio.
            Some(0) if i == 0 => rest = &rest[part.len()..],
            Some(_) if i == 0 && !pattern.starts_with('*') => return false,
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    // Si el patrón no termina en `*`, lo último tiene que cerrar la URL.
    pattern.ends_with('*') || rest.is_empty()
}

#[derive(Default)]
pub struct Mocks {
    rules: Mutex<Vec<Mock>>,
}

/// Lo que hay que contestar en vez de ir al servidor.
pub struct Canned {
    pub status: u16,
    pub content_type: String,
    pub body: String,
    pub delay_ms: u64,
}

impl Mocks {
    pub fn add(&self, mut mock: Mock) -> Result<Mock, String> {
        if mock.url.trim().is_empty() {
            return Err("la regla necesita una URL (o un pedazo de URL)".into());
        }
        if !(100..=599).contains(&mock.status) {
            return Err(format!("{} no es un código de respuesta", mock.status));
        }
        mock.id = Uuid::new_v4().to_string();
        mock.hits = 0;
        mock.method = mock.method.map(|m| m.trim().to_ascii_uppercase()).filter(|m| !m.is_empty());
        let Ok(mut rules) = self.rules.lock() else { return Err("no se pudo guardar la regla".into()) };
        if rules.len() >= MAX_MOCKS {
            return Err(format!("ya hay {MAX_MOCKS} reglas; borrá alguna antes de agregar otra"));
        }
        rules.push(mock.clone());
        Ok(mock)
    }

    pub fn list(&self) -> Vec<Mock> {
        self.rules.lock().map(|r| r.clone()).unwrap_or_default()
    }

    /// Borra una por id, o todas.
    pub fn clear(&self, id: Option<&str>) -> usize {
        let Ok(mut rules) = self.rules.lock() else { return 0 };
        let before = rules.len();
        match id {
            Some(id) => rules.retain(|m| m.id != id),
            None => rules.clear(),
        }
        before - rules.len()
    }

    /// La primera regla que cubre este pedido, ya contada. Gana la más nueva: se agrega
    /// una para cambiar lo que hacía la anterior, no para quedar atrás de ella.
    pub fn canned(&self, method: &str, url: &str) -> Option<Canned> {
        let mut rules = self.rules.lock().ok()?;
        let hit = rules.iter_mut().rev().find(|m| {
            m.method.as_deref().is_none_or(|want| want == method)
                && m.times.is_none_or(|left| m.hits < left)
                && matches(&m.url, url)
        })?;
        hit.hits += 1;
        let content_type = hit.content_type.clone().unwrap_or_else(|| guess_type(&hit.body));
        Some(Canned { status: hit.status, content_type, body: hit.body.clone(), delay_ms: hit.delay_ms })
    }
}

/// Un cuerpo que empieza con `{` o `[` es JSON: es lo que se escribe el 90% de las veces, y
/// mandarlo como texto plano haría fallar al `res.json()` de la página.
fn guess_type(body: &str) -> String {
    let start = body.trim_start().chars().next();
    match start {
        Some('{') | Some('[') => "application/json; charset=utf-8".into(),
        Some('<') => "text/html; charset=utf-8".into(),
        _ => "text/plain; charset=utf-8".into(),
    }
}
