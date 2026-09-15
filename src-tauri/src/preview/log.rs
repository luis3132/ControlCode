//! Lo que el proxy anota de cada pedido: el panel de red y las cookies del navegador.
//!
//! El proxy es el mejor lugar para mirar la red de la página, mejor que la página misma:
//! ve el documento HTML (que ningún script de la página alcanza a ver), el status exacto
//! de cada recurso (WebKit no lo expone en el Resource Timing) y las cookies `HttpOnly`,
//! que desde JavaScript son invisibles a propósito. Lo que no ve son los pedidos a OTROS
//! orígenes; esos los cuenta el runtime de la página.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

/// Donde la página pide borrar una cookie: con `HttpOnly` solo la puede borrar una
/// respuesta del servidor, y para la página el servidor es el proxy.
pub(crate) const COOKIE_CLEAR_PATH: &str = "/__controlcode__/cookies/clear";

/// Cuántos pedidos se recuerdan. Un servidor de desarrollo sirve cientos de módulos por
/// carga; esto alcanza para varias recargas sin crecer sin techo.
const MAX_ENTRIES: usize = 1500;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetEntry {
    pub seq: u64,
    /// Milisegundos desde epoch.
    pub at: i64,
    pub method: String,
    /// La URL del servidor de verdad, no la del proxy: es la que se reconoce.
    pub url: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub size: Option<u64>,
    /// Hasta que llegaron las cabeceras. Lo que tarda el cuerpo no se sabe: pasa como
    /// stream, y un Server-Sent Events no termina nunca.
    pub duration_ms: u64,
    pub error: Option<String>,
    pub websocket: bool,
}

/// Una cookie tal como la mandó el servidor, con sus atributos.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetCookie {
    pub name: String,
    pub value: String,
    pub path: Option<String>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
    /// Segundos desde epoch, de `Max-Age` o de `Expires`. `None` = de sesión.
    pub expires_at: Option<i64>,
    /// En la respuesta a qué pedido llegó.
    pub url: String,
    pub at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
}

/// Las cookies que mandó el navegador en el último pedido que llevaba alguna.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SentCookies {
    pub url: String,
    pub at: i64,
    pub cookies: Vec<Cookie>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieReport {
    /// Las que el servidor puso y siguen vigentes.
    pub set: Vec<SetCookie>,
    pub sent: Option<SentCookies>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetPage {
    pub entries: Vec<NetEntry>,
    /// El `seq` a pasar la próxima vez.
    pub next: u64,
    /// Se perdieron entradas entre la última lectura y esta (el log dio la vuelta).
    pub dropped: bool,
}

/// Un pedido ya respondido, listo para anotar.
pub struct Exchange<'a> {
    pub method: &'a str,
    pub url: String,
    pub cookie_header: Option<&'a str>,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub size: Option<u64>,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub websocket: bool,
    pub set_cookies: Vec<String>,
}

#[derive(Default)]
struct Inner {
    last_seq: u64,
    entries: VecDeque<NetEntry>,
    /// Por (nombre, path): la misma cookie en dos paths son dos cookies.
    set: BTreeMap<(String, String), SetCookie>,
    sent: Option<SentCookies>,
}

#[derive(Default)]
pub struct ProxyLog {
    inner: Mutex<Inner>,
}

impl ProxyLog {
    pub fn record(&self, ex: Exchange<'_>, now_ms: i64) {
        let Ok(mut inner) = self.inner.lock() else { return };
        inner.last_seq += 1;
        let seq = inner.last_seq;

        if let Some(header) = ex.cookie_header {
            let cookies = parse_cookie_header(header);
            if !cookies.is_empty() {
                inner.sent = Some(SentCookies { url: ex.url.clone(), at: now_ms, cookies });
            }
        }
        for line in &ex.set_cookies {
            let Some(mut cookie) = parse_set_cookie(line, now_ms / 1000) else { continue };
            cookie.url = ex.url.clone();
            cookie.at = now_ms;
            let key = (cookie.name.clone(), cookie.path.clone().unwrap_or_else(|| "/".to_string()));
            // Un `Set-Cookie` vencido es cómo un servidor borra una cookie.
            if cookie.expires_at.is_some_and(|at| at <= now_ms / 1000) {
                inner.set.remove(&key);
            } else {
                inner.set.insert(key, cookie);
            }
        }

        inner.entries.push_back(NetEntry {
            seq,
            at: now_ms,
            method: ex.method.to_string(),
            url: ex.url,
            status: ex.status,
            content_type: ex.content_type,
            size: ex.size,
            duration_ms: ex.duration_ms,
            error: ex.error,
            websocket: ex.websocket,
        });
        while inner.entries.len() > MAX_ENTRIES {
            inner.entries.pop_front();
        }
    }

    /// Lo anotado después de `since` (0 = todo lo que queda).
    pub fn since(&self, since: u64) -> NetPage {
        let Ok(inner) = self.inner.lock() else {
            return NetPage { entries: vec![], next: since, dropped: false };
        };
        let first = inner.entries.front().map(|e| e.seq);
        NetPage {
            entries: inner.entries.iter().filter(|e| e.seq > since).cloned().collect(),
            next: inner.last_seq,
            dropped: since > 0 && first.is_some_and(|f| f > since + 1),
        }
    }

    pub fn clear_network(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.entries.clear();
        }
    }

    pub fn cookies(&self, now_ms: i64) -> CookieReport {
        let Ok(inner) = self.inner.lock() else { return CookieReport { set: vec![], sent: None } };
        CookieReport {
            set: inner
                .set
                .values()
                .filter(|c| c.expires_at.is_none_or(|at| at > now_ms / 1000))
                .cloned()
                .collect(),
            sent: inner.sent.clone(),
        }
    }

    /// Olvida la cookie y devuelve los paths con los que hay que vencerla: el navegador
    /// solo la borra si el `Set-Cookie` que la vence trae el mismo `Path` que la creó.
    pub fn forget_cookie(&self, name: &str) -> Vec<String> {
        let Ok(mut inner) = self.inner.lock() else { return vec!["/".to_string()] };
        let mut paths: Vec<String> = inner.set.keys().filter(|(n, _)| n == name).map(|(_, p)| p.clone()).collect();
        inner.set.retain(|(n, _), _| n != name);
        if let Some(sent) = inner.sent.as_mut() {
            sent.cookies.retain(|c| c.name != name);
        }
        if !paths.iter().any(|p| p == "/") {
            paths.push("/".to_string());
        }
        paths
    }
}

/// `a=1; b=2` → pares. Lo que no tiene `=` se descarta: no es una cookie.
pub fn parse_cookie_header(header: &str) -> Vec<Cookie> {
    header
        .split(';')
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            let name = name.trim();
            (!name.is_empty()).then(|| Cookie { name: name.to_string(), value: value.trim().to_string() })
        })
        .collect()
}

/// Un `Set-Cookie`, con los atributos que importan para depurar por qué una cookie no
/// llega: el `Path`, `HttpOnly`, `Secure`, `SameSite` y cuándo vence.
pub fn parse_set_cookie(line: &str, now_secs: i64) -> Option<SetCookie> {
    let mut parts = line.split(';');
    let (name, value) = parts.next()?.trim().split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut cookie = SetCookie { name: name.to_string(), value: value.trim().to_string(), ..Default::default() };
    let mut max_age: Option<i64> = None;
    let mut expires: Option<i64> = None;
    for attr in parts {
        let (key, val) = match attr.trim().split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim()),
            None => (attr.trim().to_ascii_lowercase(), ""),
        };
        match key.as_str() {
            "path" if !val.is_empty() => cookie.path = Some(val.to_string()),
            "httponly" => cookie.http_only = true,
            "secure" => cookie.secure = true,
            "samesite" if !val.is_empty() => cookie.same_site = Some(val.to_string()),
            "max-age" => max_age = val.parse().ok(),
            "expires" => expires = parse_http_date(val),
            _ => {}
        }
    }
    // `Max-Age` gana sobre `Expires` cuando vienen los dos (RFC 6265 §5.3).
    cookie.expires_at = max_age.map(|s| if s <= 0 { 0 } else { now_secs + s }).or(expires);
    Some(cookie)
}

/// `Thu, 01 Jan 1970 00:00:00 GMT` → segundos desde epoch. Acepta también la variante con
/// guiones (`01-Jan-1970`) que todavía mandan algunos frameworks.
pub fn parse_http_date(text: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let cleaned = text.replace('-', " ");
    let mut day = None;
    let mut month = None;
    let mut year = None;
    let mut time = None;
    for token in cleaned.split([' ', ',']).filter(|t| !t.is_empty()) {
        if token.contains(':') {
            let mut hms = token.split(':').map(|n| n.parse::<i64>().ok());
            time = Some((hms.next()??, hms.next()??, hms.next().flatten().unwrap_or(0)));
        } else if let Some(m) = MONTHS.iter().position(|m| token.to_ascii_lowercase().starts_with(m)) {
            month = Some(m as i64 + 1);
        } else if let Ok(n) = token.parse::<i64>() {
            if n > 31 || day.is_some() {
                year = Some(if n < 100 { 1900 + n + if n < 70 { 100 } else { 0 } } else { n });
            } else {
                day = Some(n);
            }
        }
    }
    let (h, mi, s) = time.unwrap_or((0, 0, 0));
    Some(days_from_civil(year?, month?, day?) * 86_400 + h * 3600 + mi * 60 + s)
}

/// Días desde 1970-01-01 (el algoritmo de Howard Hinnant, sin tablas ni dependencias).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
