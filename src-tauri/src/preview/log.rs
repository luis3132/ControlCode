//! Lo que el proxy anota de cada pedido: el panel de red y qué cookies llevó cada uno.
//!
//! El proxy es el mejor lugar para mirar la red de la página, mejor que la página misma:
//! ve el documento HTML (que ningún script de la página alcanza a ver), el status exacto
//! de cada recurso (WebKit no lo expone en el Resource Timing), todas las cabeceras —las
//! que la política de CORS le esconde a la página también— y las cookies `HttpOnly`, que
//! desde JavaScript son invisibles a propósito. Lo que no ve son los pedidos a OTROS
//! orígenes; esos los cuenta el runtime de la página.
//!
//! Cada pedido se anota en tres tiempos: cuando llega (`begin`, y ya se ve como pendiente),
//! cuando responde el servidor (`head`) y cuando termina el cuerpo (`finish`). El listado
//! viaja liviano; cabeceras y cuerpos se piden de a un pedido con `detail`.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

/// Donde la página pide borrar una cookie: con `HttpOnly` no la puede tocar desde
/// JavaScript, y las cookies las guarda el proxy (ver `site.rs`).
pub(crate) const COOKIE_CLEAR_PATH: &str = "/__controlcode__/cookies/clear";

/// Cuántos pedidos se recuerdan. Un servidor de desarrollo sirve cientos de módulos por
/// carga; esto alcanza para varias recargas sin crecer sin techo.
const MAX_ENTRIES: usize = 1500;

/// Hasta cuánto de cada cuerpo se guarda. Alcanza para leer cualquier respuesta de una API
/// o un formulario; un bundle entero no se lee en un panel.
pub(crate) const MAX_REQUEST_BODY: usize = 256 * 1024;
pub(crate) const MAX_RESPONSE_BODY: usize = 1024 * 1024;

/// Entre todos los cuerpos guardados. Cuando se pasa se sueltan los de los pedidos más
/// viejos —se queda lo demás—: una recarga de Vite son cientos de módulos, y guardarlos
/// todos para siempre sería memoria que nadie va a mirar.
const BODY_BUDGET: usize = 64 * 1024 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// Nadie escucha en ese puerto: el servidor no está corriendo.
    ConnectionRefused,
    /// La conexión se cortó a mitad de camino (el servidor se cayó o la cerró).
    ConnectionReset,
    Timeout,
    Dns,
    Tls,
    /// El servidor contestó algo que no es HTTP válido.
    Protocol,
    /// Falló a mitad del cuerpo.
    Body,
    /// La página cortó antes de que terminara (una navegación, un Server-Sent Events).
    Aborted,
    Other,
}

/// Lo que la vista previa le hizo a una cabecera, si le hizo algo.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HeaderNote {
    /// Cambió de valor en el camino: `Host`, `Origin`, `Referer` y `Cookie` hacia el
    /// servidor; `Location` de vuelta hacia el iframe.
    Rewritten,
    /// No pasa: `Accept-Encoding` hacia el servidor; `X-Frame-Options` y la CSP hacia el iframe.
    Removed,
    /// `Set-Cookie`: no llega al iframe porque la guarda el proxy, que es quien arma el
    /// `Cookie` de cada pedido (ver `site.rs`).
    Kept,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub name: String,
    pub value: String,
    pub note: Option<HeaderNote>,
}

impl Header {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self { name: name.into(), value: value.into(), note: None }
    }

    pub fn noted(name: impl Into<String>, value: impl Into<String>, note: HeaderNote) -> Self {
        Self { name: name.into(), value: value.into(), note: Some(note) }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetEntry {
    pub seq: u64,
    /// Sube cada vez que la entrada cambia (llegaron las cabeceras, terminó el cuerpo): es lo
    /// que permite pedir "lo que cambió desde la última vez" y ver un pedido pendiente
    /// terminar.
    pub rev: u64,
    /// Milisegundos desde epoch.
    pub at: i64,
    pub method: String,
    /// La URL del servidor de verdad, no la del proxy: es la que se reconoce.
    pub url: String,
    pub status: Option<u16>,
    /// `Not Found`, `Internal Server Error`: el texto estándar del código.
    pub status_text: Option<String>,
    pub content_type: Option<String>,
    /// Lo que midió el cuerpo que pasó; antes de terminar, lo que anunció `Content-Length`.
    pub size: Option<u64>,
    /// Hasta que llegaron las cabeceras de la respuesta.
    pub ttfb_ms: Option<u64>,
    /// Hasta ahora, o hasta que terminó el cuerpo.
    pub duration_ms: u64,
    /// Terminó (bien o mal). Sin esto y sin error, el pedido sigue en curso.
    pub finished: bool,
    pub error: Option<String>,
    pub error_kind: Option<ErrorKind>,
    pub websocket: bool,
}

/// Un cuerpo tal como se guarda para mostrar.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BodyCapture {
    /// Los bytes que pasaron en total: lo guardado puede ser menos.
    pub size: u64,
    /// El contenido, si es UTF-8.
    pub text: Option<String>,
    /// El contenido si no lo es (una imagen, un binario).
    pub base64: Option<String>,
    /// Se guardó solo el principio.
    pub truncated: bool,
    /// Se soltó para hacerle lugar a pedidos más nuevos.
    pub evicted: bool,
    pub content_type: Option<String>,
    /// `Content-Encoding` de un cuerpo comprimido, que no se puede leer tal cual.
    pub encoding: Option<String>,
}

/// Todo lo que se sabe de un pedido: lo del listado más cabeceras y cuerpos.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    #[serde(flatten)]
    pub entry: NetEntry,
    /// Como las recibió el servidor.
    pub request_headers: Vec<Header>,
    /// Como las mandó el servidor.
    pub response_headers: Vec<Header>,
    pub http_version: Option<String>,
    pub remote_address: Option<String>,
    pub request_body: Option<BodyCapture>,
    pub response_body: Option<BodyCapture>,
}

/// Una cookie tal como la mandó el servidor, con sus atributos. Es también lo que se guarda
/// de cada una en el archivo del sitio.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SetCookie {
    pub name: String,
    pub value: String,
    pub path: Option<String>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
    /// Segundos desde epoch, de `Max-Age` o de `Expires`. `None` = de sesión.
    pub expires_at: Option<i64>,
    /// En la respuesta a qué pedido llegó (o en qué página la puso un script).
    pub url: String,
    pub at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
}

/// Las cookies que llevó al servidor el último pedido que llevaba alguna.
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
    /// Las que tiene guardadas el sitio y siguen vigentes.
    pub set: Vec<SetCookie>,
    pub sent: Option<SentCookies>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetPage {
    /// Las entradas nuevas o que cambiaron desde la lectura anterior.
    pub entries: Vec<NetEntry>,
    /// El `rev` a pasar la próxima vez.
    pub next: u64,
    /// Se perdieron entradas entre la última lectura y esta (el log dio la vuelta).
    pub dropped: bool,
}

/// Un pedido que acaba de llegar, antes de reenviarlo.
pub struct Begin<'a> {
    pub method: &'a str,
    pub url: String,
    pub cookie_header: Option<&'a str>,
    pub request_headers: Vec<Header>,
    pub request_body: &'a [u8],
    pub request_content_type: Option<String>,
    pub websocket: bool,
}

/// Llegaron las cabeceras de la respuesta.
pub struct Head {
    pub status: u16,
    pub headers: Vec<Header>,
    pub http_version: Option<String>,
    pub remote_address: Option<String>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub ttfb_ms: u64,
}

/// Terminó: con el cuerpo que pasó, o con un error.
pub struct Finish {
    pub body: Vec<u8>,
    pub body_size: u64,
    pub truncated: bool,
    pub encoding: Option<String>,
    pub duration_ms: u64,
    pub error: Option<(ErrorKind, String)>,
}

impl Finish {
    pub fn failed(kind: ErrorKind, message: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            body: Vec::new(),
            body_size: 0,
            truncated: false,
            encoding: None,
            duration_ms,
            error: Some((kind, message.into())),
        }
    }
}

struct Stored {
    bytes: Vec<u8>,
    size: u64,
    truncated: bool,
    evicted: bool,
    content_type: Option<String>,
    encoding: Option<String>,
}

impl Stored {
    fn capture(&self) -> BodyCapture {
        let (text, base64) = if self.evicted {
            (None, None)
        } else {
            match std::str::from_utf8(&self.bytes) {
                Ok(text) => (Some(text.to_string()), None),
                // Cortado a mitad de un carácter multibyte sigue siendo texto: se descarta la
                // cola incompleta en vez de mostrarlo como binario.
                Err(e) if self.truncated && e.error_len().is_none() => {
                    (Some(String::from_utf8_lossy(&self.bytes[..e.valid_up_to()]).into_owned()), None)
                }
                Err(_) => (None, Some(base64::engine::general_purpose::STANDARD.encode(&self.bytes))),
            }
        };
        BodyCapture {
            size: self.size,
            text,
            base64,
            truncated: self.truncated,
            evicted: self.evicted,
            content_type: self.content_type.clone(),
            encoding: self.encoding.clone(),
        }
    }
}

#[derive(Default)]
struct Detail {
    request_headers: Vec<Header>,
    response_headers: Vec<Header>,
    http_version: Option<String>,
    remote_address: Option<String>,
    request_body: Option<Stored>,
    response_body: Option<Stored>,
}

#[derive(Default)]
struct Inner {
    last_seq: u64,
    last_rev: u64,
    /// El `rev` más alto de lo que se descartó por espacio: quien leyó hasta antes de eso se
    /// perdió algo.
    evicted_rev: u64,
    entries: VecDeque<NetEntry>,
    details: BTreeMap<u64, Detail>,
    body_bytes: usize,
    sent: Option<SentCookies>,
}

impl Inner {
    fn touch(&mut self, seq: u64, update: impl FnOnce(&mut NetEntry)) {
        self.last_rev += 1;
        let rev = self.last_rev;
        if let Some(entry) = self.entries.iter_mut().rev().find(|e| e.seq == seq) {
            update(entry);
            entry.rev = rev;
        }
    }

    fn store_body(&mut self, seq: u64, stored: Stored, response: bool) {
        let Some(detail) = self.details.get_mut(&seq) else { return };
        self.body_bytes += stored.bytes.len();
        let slot = if response { &mut detail.response_body } else { &mut detail.request_body };
        if let Some(old) = slot.replace(stored) {
            self.body_bytes -= old.bytes.len();
        }
        // Se sueltan de los más viejos para atrás; el pedido que acaba de terminar no, que es
        // justo el que alguien está por mirar.
        let seqs: Vec<u64> = self.details.keys().copied().filter(|&s| s != seq).collect();
        for old in seqs {
            if self.body_bytes <= BODY_BUDGET {
                break;
            }
            if let Some(detail) = self.details.get_mut(&old) {
                for body in [&mut detail.request_body, &mut detail.response_body].into_iter().flatten() {
                    if !body.evicted {
                        self.body_bytes -= body.bytes.len();
                        body.bytes = Vec::new();
                        body.evicted = true;
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub struct ProxyLog {
    inner: Mutex<Inner>,
}

/// Lo que se guarda de un cuerpo: el principio, hasta `max`.
pub(crate) fn clip(bytes: &[u8], max: usize) -> (Vec<u8>, bool) {
    if bytes.len() > max {
        (bytes[..max].to_vec(), true)
    } else {
        (bytes.to_vec(), false)
    }
}

impl ProxyLog {
    /// Anota un pedido que acaba de llegar. Devuelve su `seq`, con el que se lo completa.
    pub fn begin(&self, b: Begin<'_>, now_ms: i64) -> u64 {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        inner.last_seq += 1;
        inner.last_rev += 1;
        let seq = inner.last_seq;

        if let Some(header) = b.cookie_header {
            let cookies = parse_cookie_header(header);
            if !cookies.is_empty() {
                inner.sent = Some(SentCookies { url: b.url.clone(), at: now_ms, cookies });
            }
        }

        let entry = NetEntry {
            seq,
            rev: inner.last_rev,
            at: now_ms,
            method: b.method.to_string(),
            url: b.url,
            status: None,
            status_text: None,
            content_type: None,
            size: None,
            ttfb_ms: None,
            duration_ms: 0,
            finished: false,
            error: None,
            error_kind: None,
            websocket: b.websocket,
        };
        inner.entries.push_back(entry);
        inner.details.insert(seq, Detail { request_headers: b.request_headers, ..Default::default() });
        if !b.request_body.is_empty() {
            let (bytes, truncated) = clip(b.request_body, MAX_REQUEST_BODY);
            let stored = Stored {
                bytes,
                size: b.request_body.len() as u64,
                truncated,
                evicted: false,
                content_type: b.request_content_type,
                encoding: None,
            };
            inner.store_body(seq, stored, false);
        }

        while inner.entries.len() > MAX_ENTRIES {
            if let Some(old) = inner.entries.pop_front() {
                inner.evicted_rev = inner.evicted_rev.max(old.rev);
                if let Some(detail) = inner.details.remove(&old.seq) {
                    let freed: usize = [detail.request_body, detail.response_body]
                        .into_iter()
                        .flatten()
                        .map(|b| b.bytes.len())
                        .sum();
                    inner.body_bytes -= freed;
                }
            }
        }
        seq
    }

    pub fn head(&self, seq: u64, head: Head) {
        let Ok(mut inner) = self.inner.lock() else { return };
        let status_text = hyper::StatusCode::from_u16(head.status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .map(str::to_string);
        inner.touch(seq, |entry| {
            entry.status = Some(head.status);
            entry.status_text = status_text;
            entry.content_type = head.content_type.clone();
            entry.size = head.content_length;
            entry.ttfb_ms = Some(head.ttfb_ms);
            entry.duration_ms = head.ttfb_ms;
        });
        if let Some(detail) = inner.details.get_mut(&seq) {
            detail.response_headers = head.headers;
            detail.http_version = head.http_version;
            detail.remote_address = head.remote_address;
        }
    }

    pub fn finish(&self, seq: u64, finish: Finish) {
        let Ok(mut inner) = self.inner.lock() else { return };
        let content_type = inner.entries.iter().rev().find(|e| e.seq == seq).and_then(|e| e.content_type.clone());
        let has_body = finish.body_size > 0;
        inner.touch(seq, |entry| {
            entry.finished = true;
            entry.duration_ms = finish.duration_ms;
            if has_body || entry.status.is_some() {
                entry.size = Some(finish.body_size);
            }
            if let Some((kind, message)) = &finish.error {
                entry.error_kind = Some(*kind);
                entry.error = Some(message.clone());
            }
        });
        if has_body {
            let stored = Stored {
                bytes: finish.body,
                size: finish.body_size,
                truncated: finish.truncated,
                evicted: false,
                content_type,
                encoding: finish.encoding,
            };
            inner.store_body(seq, stored, true);
        }
    }

    /// Lo que cambió después de `since` (0 = todo lo que queda).
    pub fn since(&self, since: u64) -> NetPage {
        let Ok(inner) = self.inner.lock() else {
            return NetPage { entries: vec![], next: since, dropped: false };
        };
        NetPage {
            entries: inner.entries.iter().filter(|e| e.rev > since).cloned().collect(),
            next: inner.last_rev,
            dropped: since > 0 && inner.evicted_rev > since,
        }
    }

    pub fn detail(&self, seq: u64) -> Option<RequestDetail> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.entries.iter().rev().find(|e| e.seq == seq)?.clone();
        let detail = inner.details.get(&seq)?;
        Some(RequestDetail {
            entry,
            request_headers: detail.request_headers.clone(),
            response_headers: detail.response_headers.clone(),
            http_version: detail.http_version.clone(),
            remote_address: detail.remote_address.clone(),
            request_body: detail.request_body.as_ref().map(Stored::capture),
            response_body: detail.response_body.as_ref().map(Stored::capture),
        })
    }

    pub fn clear_network(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            // Lo que sigue en curso se queda: su respuesta todavía tiene que poder anotarse.
            let pending: Vec<u64> = inner.entries.iter().filter(|e| !e.finished).map(|e| e.seq).collect();
            inner.entries.retain(|e| !e.finished);
            inner.details.retain(|seq, _| pending.contains(seq));
            inner.body_bytes = inner
                .details
                .values()
                .flat_map(|d| [&d.request_body, &d.response_body])
                .flatten()
                .map(|b| b.bytes.len())
                .sum();
        }
    }

    /// Las cookies del último pedido que llevaba alguna.
    pub fn sent(&self) -> Option<SentCookies> {
        self.inner.lock().ok().and_then(|inner| inner.sent.clone())
    }

    /// Una cookie que se borró deja de figurar entre las que se mandaron.
    pub fn forget_sent(&self, name: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(sent) = inner.sent.as_mut()
        {
            sent.cookies.retain(|c| c.name != name);
        }
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
