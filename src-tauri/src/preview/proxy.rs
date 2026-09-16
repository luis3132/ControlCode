//! El servidor del proxy: uno por origen de destino, en el loopback.
//!
//! Uno por origen (y no uno solo con el destino en la ruta) porque así las rutas absolutas
//! de la página (`/assets/app.js`, `/api/login`) siguen funcionando sin reescribir nada:
//! para el iframe, el proxy ES el servidor.
//!
//! Eso tiene una consecuencia que no se ve hasta que falla: el origen de la página deja de
//! ser el del servidor (`http://localhost:5173`) y pasa a ser el del proxy. Todo lo que
//! depende del origen —el CORS de una API en otro puerto, el localStorage, las cookies— lo
//! ve a él. Por eso el proxy se sirve con el mismo nombre con que se abrió el servidor
//! (`localhost`, no `127.0.0.1`) y en un puerto que no cambia entre arranques; ver
//! `proxy_host` y `preferred_port`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::Stream;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{
    HeaderValue, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, ORIGIN, REFERER, SET_COOKIE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use super::log::{
    clip, Begin, CookieReport, ErrorKind, Finish, Head, Header, HeaderNote, NetPage, ProxyLog, RequestDetail,
    COOKIE_CLEAR_PATH, MAX_RESPONSE_BODY,
};
use super::mocks::{Mock, Mocks};
use super::rewrite::{
    inject_picker, is_hop_by_hop, is_local_host, parse_response_head, rewrite_location, rewrite_origin_value,
    skip_request_header, skip_response_header, strip_cookie_domain, PICKER_PATH,
};

/// El script que se inyecta: el selector y el runtime de la página. Lo compila y lo manda
/// la app (`src/features/browser/picker.ts` y `page/runtime.ts`) en cada `preview_resolve`:
/// así el backend no carga una copia de código de frontend que pueda quedar desactualizada,
/// y en desarrollo un cambio se ve sin recompilar Rust.
static PICKER: LazyLock<RwLock<String>> = LazyLock::new(|| RwLock::new(String::new()));

type Body = BoxBody<Bytes, std::io::Error>;

/// Un proxy levantado: dónde atiende y lo que lleva anotado.
#[derive(Clone)]
struct Proxy {
    port: u16,
    /// `http://localhost:41234`: el origen que tiene la página.
    origin: String,
    log: Arc<ProxyLog>,
    mocks: Arc<Mocks>,
}

/// Origen de destino → el proxy que lo atiende. Viven lo que vive la app: abrir otra vez
/// el mismo proyecto reusa el mismo proxy, y con él sus cookies y su log de red.
static PROXIES: LazyLock<Mutex<HashMap<String, Proxy>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Ctx {
    /// `http://localhost:5173`, sin barra final.
    target_origin: String,
    target_host: String,
    target_port: u16,
    /// Lo que va en `Host`: con puerto si no es el de siempre.
    host_header: String,
    is_http: bool,
    proxy_origin: String,
    client: reqwest::Client,
    log: Arc<ProxyLog>,
    mocks: Arc<Mocks>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    /// Lo que va en el `src` del iframe.
    pub proxied_url: String,
    pub proxy_origin: String,
    pub target_origin: String,
}

fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into()).map_err(|never| match never {}).boxed()
}

fn error_page(status: u16, target: &str, detail: &str) -> Response<Body> {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let html = format!(
        "<!doctype html><html><head><meta charset=utf-8><title>{status}</title></head>\
         <body style=\"font:14px system-ui;padding:40px;color:#6b7280;background:transparent\">\
         <p style=\"font-weight:600;color:#374151\">No se pudo conectar con {}</p>\
         <p>¿Está corriendo el servidor?</p><pre style=\"white-space:pre-wrap\">{}</pre></body></html>",
        escape(target),
        escape(detail)
    );
    // Con el runtime adentro, igual que cualquier página: la app se entera de que "cargó"
    // (un agente que navegó ve el error enseguida, sin esperar a que se venza) y el panel
    // sigue funcionando.
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(full(inject_picker(&html)))
        .expect("respuesta de error válida")
}

/// Lo que marca una respuesta que salió de una regla y no del servidor.
const MOCK_HEADER: &str = "x-controlcode-mock";

fn is_websocket(req: &Request<Incoming>) -> bool {
    req.headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn handle(req: Request<Incoming>, ctx: Arc<Ctx>) -> Response<Body> {
    if req.uri().path() == PICKER_PATH {
        return Response::builder()
            .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
            .header("cache-control", "no-store")
            .body(full(PICKER.read().map(|p| p.clone()).unwrap_or_default()))
            .expect("respuesta del selector válida");
    }
    if req.uri().path() == COOKIE_CLEAR_PATH {
        return clear_cookie(&req, &ctx);
    }
    let started = Instant::now();
    if is_websocket(&req) {
        return websocket(req, &ctx, started).await;
    }
    // Una regla del agente contesta en lugar del servidor: es la única forma de probar a
    // mano un 500, una lista vacía o una respuesta lenta sin tocar el código del proyecto.
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
    if let Some(canned) = ctx.mocks.canned(req.method().as_str(), &path) {
        return serve_mock(req, &ctx, started, canned).await;
    }
    forward(req, &ctx, started).await
}

/// Contesta desde una regla, y lo anota como cualquier otro pedido para que se vea en el
/// panel de red —con la cabecera que dice que fue simulado.
async fn serve_mock(
    req: Request<Incoming>,
    ctx: &Ctx,
    started: Instant,
    canned: super::mocks::Canned,
) -> Response<Body> {
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
    let url = format!("{}{}", ctx.target_origin, path);
    let method = req.method().as_str().to_string();
    let cookie_header = req.headers().get(COOKIE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let request_type = req.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (_, shown) = upstream_request_headers(&req, ctx);
    let body = req.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();

    let seq = ctx.log.begin(
        Begin {
            method: &method,
            url,
            cookie_header: cookie_header.as_deref(),
            request_headers: shown,
            request_body: &body,
            request_content_type: request_type,
            websocket: false,
        },
        now_ms(),
    );

    if canned.delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(canned.delay_ms.min(30_000))).await;
    }

    let payload = canned.body.into_bytes();
    ctx.log.head(
        seq,
        Head {
            status: canned.status,
            headers: vec![
                Header::new(CONTENT_TYPE.as_str(), canned.content_type.clone()),
                Header::new(MOCK_HEADER, "1"),
            ],
            http_version: None,
            remote_address: None,
            set_cookies: Vec::new(),
            content_type: Some(canned.content_type.clone()),
            content_length: Some(payload.len() as u64),
            ttfb_ms: elapsed_ms(started),
        },
        now_ms(),
    );
    ctx.log.finish(
        seq,
        Finish {
            body_size: payload.len() as u64,
            truncated: false,
            encoding: None,
            duration_ms: elapsed_ms(started),
            error: None,
            body: payload.iter().copied().take(MAX_RESPONSE_BODY).collect(),
        },
    );

    Response::builder()
        .status(canned.status)
        .header(CONTENT_TYPE, canned.content_type)
        .header(MOCK_HEADER, "1")
        .body(full(payload))
        .unwrap_or_else(|_| error_page(500, &ctx.target_origin, "la regla simulada no es una respuesta válida"))
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

fn version_text(version: reqwest::Version) -> String {
    match version {
        reqwest::Version::HTTP_09 => "HTTP/0.9",
        reqwest::Version::HTTP_10 => "HTTP/1.0",
        reqwest::Version::HTTP_11 => "HTTP/1.1",
        reqwest::Version::HTTP_2 => "HTTP/2",
        reqwest::Version::HTTP_3 => "HTTP/3",
        _ => "HTTP",
    }
    .to_string()
}

/// El mensaje entero de un error y, si hay, el `io::ErrorKind` de adentro. Lo útil
/// ("Connection refused") suele estar varias capas abajo, en las `source()`.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> (String, Option<std::io::ErrorKind>) {
    let mut parts: Vec<String> = Vec::new();
    let mut io_kind = None;
    let mut current = Some(error);
    while let Some(e) = current {
        let text = e.to_string();
        // Cada capa suele repetir la de adentro: se agrega solo lo que suma.
        if !text.is_empty() && !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        if io_kind.is_none() {
            io_kind = e.downcast_ref::<std::io::Error>().map(std::io::Error::kind);
        }
        current = e.source();
    }
    (parts.join(": "), io_kind)
}

/// De qué clase es una falla de red, para poder decir qué hacer con ella.
pub(crate) fn error_kind(io: Option<std::io::ErrorKind>, message: &str) -> Option<ErrorKind> {
    use std::io::ErrorKind as Io;
    let by_io = io.and_then(|kind| match kind {
        Io::ConnectionRefused => Some(ErrorKind::ConnectionRefused),
        Io::ConnectionReset | Io::ConnectionAborted | Io::BrokenPipe | Io::UnexpectedEof => Some(ErrorKind::ConnectionReset),
        Io::TimedOut => Some(ErrorKind::Timeout),
        _ => None,
    });
    by_io.or_else(|| {
        let lower = message.to_ascii_lowercase();
        if lower.contains("connection refused") {
            Some(ErrorKind::ConnectionRefused)
        } else if lower.contains("connection reset") || lower.contains("connection closed") {
            Some(ErrorKind::ConnectionReset)
        } else if lower.contains("timed out") || lower.contains("timeout") {
            Some(ErrorKind::Timeout)
        } else if lower.contains("dns error") || lower.contains("failed to lookup") || lower.contains("name or service not known") {
            Some(ErrorKind::Dns)
        } else if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake") {
            Some(ErrorKind::Tls)
        } else if lower.contains("invalid http") || lower.contains("parse error") {
            Some(ErrorKind::Protocol)
        } else {
            None
        }
    })
}

fn classify(error: &reqwest::Error) -> (ErrorKind, String) {
    let (message, io) = error_chain(error);
    let kind = if error.is_timeout() { Some(ErrorKind::Timeout) } else { None }
        .or_else(|| error_kind(io, &message))
        .unwrap_or(if error.is_body() || error.is_decode() { ErrorKind::Body } else { ErrorKind::Other });
    (kind, message)
}

/// Las cabeceras que se le mandan al servidor y cómo mostrarlas: tal como las recibe él,
/// marcando lo que la vista previa cambió en el camino.
fn upstream_request_headers(req: &Request<Incoming>, ctx: &Ctx) -> (reqwest::header::HeaderMap, Vec<Header>) {
    let mut headers = reqwest::header::HeaderMap::new();
    let mut shown = Vec::new();
    for (name, value) in req.headers() {
        let text = String::from_utf8_lossy(value.as_bytes()).into_owned();
        if *name == HOST {
            shown.push(Header::noted(name.as_str(), ctx.host_header.clone(), HeaderNote::Rewritten));
            continue;
        }
        if skip_request_header(name.as_str()) {
            // `Content-Length` lo vuelve a poner el cliente y lo de un salto no es del pedido;
            // `Accept-Encoding` sí lo mandó la página, y el servidor no lo ve.
            if name.as_str() == "accept-encoding" {
                shown.push(Header::noted(name.as_str(), text, HeaderNote::Removed));
            }
            continue;
        }
        if (*name == ORIGIN || *name == REFERER)
            && let Ok(original) = value.to_str()
        {
            let rewritten = rewrite_origin_value(original, &ctx.proxy_origin, &ctx.target_origin);
            if let Ok(v) = HeaderValue::from_str(&rewritten) {
                let note = (rewritten != original).then_some(HeaderNote::Rewritten);
                shown.push(Header { name: name.as_str().to_string(), value: rewritten, note });
                headers.append(name.clone(), v);
            }
            continue;
        }
        shown.push(Header::new(name.as_str(), text));
        headers.append(name.clone(), value.clone());
    }
    (headers, shown)
}

/// Vence una cookie desde el servidor: la única forma de borrar una `HttpOnly`. Lo pide el
/// runtime de la página, que desde JavaScript solo puede borrar las otras.
fn clear_cookie(req: &Request<Incoming>, ctx: &Ctx) -> Response<Body> {
    let name = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("name=")))
        .map(percent_decode)
        .unwrap_or_default();
    let mut builder = Response::builder().status(204).header("cache-control", "no-store");
    // Un nombre con `;` o `=` inyectaría atributos en el `Set-Cookie`.
    if name.is_empty() || name.contains([';', '=', ',', ' ', '\r', '\n']) {
        return builder.status(400).body(full(Bytes::new())).expect("respuesta válida");
    }
    for path in ctx.log.forget_cookie(&name) {
        if let Ok(value) = HeaderValue::from_str(&format!("{name}=; Max-Age=0; Path={path}")) {
            builder = builder.header(SET_COOKIE, value);
        }
    }
    builder.body(full(Bytes::new())).expect("respuesta válida")
}

/// `%20` → espacio. Solo lo que hace falta para el nombre de una cookie en la query.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Sobre bytes y no sobre el `&str`: cortar `text` justo después de un `%` seguido
            // de un carácter multibyte entraría en pánico.
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn forward(req: Request<Incoming>, ctx: &Ctx, started: Instant) -> Response<Body> {
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}{}", ctx.target_origin, path);
    let method = req.method().clone();
    let cookie_header = req.headers().get(COOKIE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let request_type = req.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (headers, mut shown) = upstream_request_headers(&req, ctx);

    let (body, body_error) = match req.into_body().collect().await {
        Ok(collected) => (collected.to_bytes(), None),
        Err(e) => (Bytes::new(), Some(e)),
    };
    if !body.is_empty() {
        shown.push(Header::new("content-length", body.len().to_string()));
    }
    let seq = ctx.log.begin(
        Begin {
            method: method.as_str(),
            url: url.clone(),
            cookie_header: cookie_header.as_deref(),
            request_headers: shown,
            request_body: &body,
            request_content_type: request_type,
            websocket: false,
        },
        now_ms(),
    );
    if let Some(e) = body_error {
        let message = format!("no se pudo leer el cuerpo del pedido: {e}");
        ctx.log.finish(seq, Finish::failed(ErrorKind::Aborted, message.clone(), elapsed_ms(started)));
        return error_page(502, &ctx.target_origin, &message);
    }

    let upstream = match ctx.client.request(method, &url).headers(headers).body(body).send().await {
        Ok(upstream) => upstream,
        Err(e) => {
            let (kind, message) = classify(&e);
            ctx.log.finish(seq, Finish::failed(kind, message.clone(), elapsed_ms(started)));
            return error_page(502, &ctx.target_origin, &message);
        }
    };

    let status = upstream.status();
    let content_type = upstream.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let encoding = upstream
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .filter(|e| !e.eq_ignore_ascii_case("identity"))
        .map(str::to_string);
    let is_html = content_type.as_deref().is_some_and(|t| t.to_ascii_lowercase().starts_with("text/html")) && encoding.is_none();

    let mut builder = Response::builder().status(status);
    let mut response_headers = Vec::new();
    let mut set_cookies = Vec::new();
    for (name, value) in upstream.headers() {
        let text = String::from_utf8_lossy(value.as_bytes()).into_owned();
        if *name == SET_COOKIE {
            set_cookies.push(text.clone());
        }
        if skip_response_header(name.as_str()) || (is_html && *name == CONTENT_LENGTH) {
            let note = (!is_hop_by_hop(name.as_str())).then_some(HeaderNote::Removed);
            response_headers.push(Header { name: name.as_str().to_string(), value: text, note });
            continue;
        }
        let forwarded = match (name, value.to_str()) {
            (n, Ok(original)) if *n == LOCATION => {
                HeaderValue::from_str(&rewrite_location(original, &ctx.target_origin, &ctx.proxy_origin))
                    .unwrap_or_else(|_| value.clone())
            }
            (n, Ok(original)) if *n == SET_COOKIE => {
                HeaderValue::from_str(&strip_cookie_domain(original)).unwrap_or_else(|_| value.clone())
            }
            _ => value.clone(),
        };
        let note = (forwarded != value).then_some(HeaderNote::Rewritten);
        response_headers.push(Header { name: name.as_str().to_string(), value: text, note });
        builder = builder.header(name, forwarded);
    }
    ctx.log.head(
        seq,
        Head {
            status: status.as_u16(),
            headers: response_headers,
            http_version: Some(version_text(upstream.version())),
            remote_address: upstream.remote_addr().map(|a| a.to_string()),
            set_cookies,
            content_type,
            content_length: upstream.content_length(),
            ttfb_ms: elapsed_ms(started),
        },
        now_ms(),
    );

    if is_html {
        let bytes = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => {
                let (kind, message) = classify(&e);
                ctx.log.finish(seq, Finish::failed(kind, message.clone(), elapsed_ms(started)));
                return error_page(502, &ctx.target_origin, &message);
            }
        };
        let (captured, truncated) = clip(&bytes, MAX_RESPONSE_BODY);
        ctx.log.finish(
            seq,
            Finish {
                body: captured,
                body_size: bytes.len() as u64,
                truncated,
                encoding: None,
                duration_ms: elapsed_ms(started),
                error: None,
            },
        );
        // Un HTML que no es UTF-8 se deja pasar sin selector antes que corromperlo.
        let body = match std::str::from_utf8(&bytes) {
            Ok(text) => full(inject_picker(text)),
            Err(_) => full(bytes),
        };
        return builder.body(body).unwrap_or_else(|e| error_page(502, &ctx.target_origin, &e.to_string()));
    }

    // Todo lo demás pasa como stream: un Server-Sent Events del live reload nunca termina,
    // y leerlo entero antes de devolverlo lo dejaría colgado. El principio se va copiando
    // para el panel mientras pasa.
    let tee = TeeStream {
        expected: upstream.content_length(),
        inner: Box::pin(upstream.bytes_stream()),
        log: ctx.log.clone(),
        seq,
        started,
        captured: Vec::new(),
        size: 0,
        truncated: false,
        encoding,
        done: false,
    };
    builder
        .body(StreamBody::new(tee).boxed())
        .unwrap_or_else(|e| error_page(502, &ctx.target_origin, &e.to_string()))
}

/// El cuerpo de una respuesta que pasa como stream: guarda el principio para el panel y le
/// avisa al log cuando termina, falla, o la página corta antes.
struct TeeStream {
    inner: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send + Sync>>,
    log: Arc<ProxyLog>,
    seq: u64,
    started: Instant,
    /// El `Content-Length` anunciado. hyper deja de pedir el cuerpo apenas mandó esa cantidad
    /// de bytes, sin esperar el final del stream: haber llegado a eso ES haber terminado.
    expected: Option<u64>,
    captured: Vec<u8>,
    size: u64,
    truncated: bool,
    encoding: Option<String>,
    done: bool,
}

impl TeeStream {
    fn complete(&self) -> bool {
        self.expected.is_some_and(|len| self.size >= len)
    }

    fn finish(&mut self, error: Option<(ErrorKind, String)>) {
        if self.done {
            return;
        }
        self.done = true;
        self.log.finish(
            self.seq,
            Finish {
                body: std::mem::take(&mut self.captured),
                body_size: self.size,
                truncated: self.truncated,
                encoding: self.encoding.take(),
                duration_ms: elapsed_ms(self.started),
                error,
            },
        );
    }
}

impl Stream for TeeStream {
    type Item = Result<Frame<Bytes>, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.size += chunk.len() as u64;
                let room = MAX_RESPONSE_BODY.saturating_sub(self.captured.len());
                let take = room.min(chunk.len());
                self.captured.extend_from_slice(&chunk[..take]);
                if take < chunk.len() {
                    self.truncated = true;
                }
                if self.complete() {
                    self.finish(None);
                }
                Poll::Ready(Some(Ok(Frame::data(chunk))))
            }
            Poll::Ready(Some(Err(e))) => {
                let (kind, message) = classify(&e);
                let kind = if kind == ErrorKind::Other { ErrorKind::Body } else { kind };
                self.finish(Some((kind, message.clone())));
                Poll::Ready(Some(Err(std::io::Error::other(message))))
            }
            Poll::Ready(None) => {
                self.finish(None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for TeeStream {
    fn drop(&mut self) {
        if !self.done && self.complete() {
            self.finish(None);
        } else if !self.done {
            self.finish(Some((
                ErrorKind::Aborted,
                "la página cortó la conexión antes de que terminara la respuesta".to_string(),
            )));
        }
    }
}

/// El WebSocket del recargado en caliente (Vite, Next, webpack). Se reenvía el pedido de
/// upgrade al servidor y, si acepta, se conectan las dos puntas byte a byte.
async fn websocket(mut req: Request<Incoming>, ctx: &Ctx, started: Instant) -> Response<Body> {
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
    let url = format!("{}{}", ctx.target_origin, path);
    let method = req.method().to_string();

    let mut head = format!("{method} {path} HTTP/1.1\r\nhost: {}\r\n", ctx.host_header);
    let mut shown = vec![Header::noted("host", ctx.host_header.clone(), HeaderNote::Rewritten)];
    for (name, value) in req.headers() {
        if *name == HOST {
            continue;
        }
        let Ok(text) = value.to_str() else { continue };
        let sent = if *name == ORIGIN {
            rewrite_origin_value(text, &ctx.proxy_origin, &ctx.target_origin)
        } else {
            text.to_string()
        };
        let note = (sent != text).then_some(HeaderNote::Rewritten);
        head.push_str(&format!("{}: {}\r\n", name.as_str(), sent));
        shown.push(Header { name: name.as_str().to_string(), value: sent, note });
    }
    head.push_str("\r\n");

    let seq = ctx.log.begin(
        Begin {
            method: &method,
            url,
            cookie_header: req.headers().get(COOKIE).and_then(|v| v.to_str().ok()),
            request_headers: shown,
            request_body: &[],
            request_content_type: None,
            websocket: true,
        },
        now_ms(),
    );
    let fail = |kind: ErrorKind, message: String| {
        ctx.log.finish(seq, Finish::failed(kind, message.clone(), elapsed_ms(started)));
        error_page(502, &ctx.target_origin, &message)
    };
    if !ctx.is_http {
        return fail(ErrorKind::Other, "La vista previa todavía no reenvía WebSockets seguros (wss).".to_string());
    }

    let on_upgrade = hyper::upgrade::on(&mut req);
    let mut upstream = match TcpStream::connect((ctx.target_host.as_str(), ctx.target_port)).await {
        Ok(upstream) => upstream,
        Err(e) => {
            let message = e.to_string();
            return fail(error_kind(Some(e.kind()), &message).unwrap_or(ErrorKind::Other), message);
        }
    };
    let remote_address = upstream.peer_addr().ok().map(|a| a.to_string());
    if let Err(e) = upstream.write_all(head.as_bytes()).await {
        let message = e.to_string();
        return fail(error_kind(Some(e.kind()), &message).unwrap_or(ErrorKind::Other), message);
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = match upstream.read(&mut chunk).await {
            Ok(n) => n,
            Err(e) => {
                let message = e.to_string();
                return fail(error_kind(Some(e.kind()), &message).unwrap_or(ErrorKind::Other), message);
            }
        };
        if n == 0 {
            return fail(ErrorKind::ConnectionReset, "el servidor cerró la conexión".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return fail(ErrorKind::Protocol, "la cabecera de la respuesta es demasiado larga".to_string());
        }
    };
    let Some((status, headers)) = parse_response_head(&String::from_utf8_lossy(&buf[..header_end])) else {
        return fail(ErrorKind::Protocol, "respuesta inválida del servidor".to_string());
    };
    let leftover = buf[header_end..].to_vec();

    let mut builder = Response::builder().status(status);
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    ctx.log.head(
        seq,
        Head {
            status,
            headers: headers.iter().map(|(n, v)| Header::new(n.to_ascii_lowercase(), v.clone())).collect(),
            http_version: Some("HTTP/1.1".to_string()),
            remote_address,
            set_cookies: headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("set-cookie"))
                .map(|(_, v)| v.clone())
                .collect(),
            content_type: None,
            content_length: None,
            ttfb_ms: elapsed_ms(started),
        },
        now_ms(),
    );
    // Lo que viaja por el socket no se guarda: el pedido termina cuando se conecta.
    ctx.log.finish(
        seq,
        Finish { body: Vec::new(), body_size: 0, truncated: false, encoding: None, duration_ms: elapsed_ms(started), error: None },
    );
    if status != 101 {
        return builder.body(full(leftover)).unwrap_or_else(|e| error_page(502, &ctx.target_origin, &e.to_string()));
    }

    tokio::spawn(async move {
        if let Ok(upgraded) = on_upgrade.await {
            let mut client = TokioIo::new(upgraded);
            if !leftover.is_empty() && client.write_all(&leftover).await.is_err() {
                return;
            }
            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        }
    });
    builder.body(full(Bytes::new())).unwrap_or_else(|e| error_page(502, &ctx.target_origin, &e.to_string()))
}

/// Los puertos de donde sale el de cada proxy. Adentro del rango efímero a propósito: los
/// servicios no se instalan ahí, así que un proxy no le va a ganar el puerto a un programa
/// del usuario que arranque después.
const PREFERRED_PORTS: std::ops::Range<u16> = 41_000..49_000;

/// Con qué nombre se sirve la página —y por lo tanto su origen—: el mismo loopback con que
/// se abrió el servidor, como lo vería un navegador. Un backend en desarrollo suele aceptar
/// CORS de `http://localhost:*` y no de `127.0.0.1` (o al revés): servida siempre desde
/// `127.0.0.1`, una página abierta como `localhost:5173` veía fallar todas sus llamadas a la
/// API con un "Failed to fetch" que en un navegador normal no pasaba.
pub(crate) fn proxy_host(target_host: &str) -> &'static str {
    let bare = target_host.trim_start_matches('[').trim_end_matches(']');
    if bare.starts_with("127.") {
        "127.0.0.1"
    } else if bare == "::1" {
        "[::1]"
    } else {
        "localhost"
    }
}

/// El puerto que le toca al proxy de un servidor, siempre el mismo. Con uno al azar en cada
/// arranque el origen de la página cambiaba cada vez: se perdían su localStorage y sus
/// cookies (la sesión iniciada), y no había forma de agregarlo a la lista de CORS de una API.
pub(crate) fn preferred_port(target_origin: &str) -> u16 {
    // FNV-1a y no el `Hasher` de la biblioteca estándar, que no promete dar lo mismo entre
    // versiones de Rust: una actualización cambiaría todos los orígenes.
    let hash = target_origin.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
    let span = (PREFERRED_PORTS.end - PREFERRED_PORTS.start) as u32;
    PREFERRED_PORTS.start + (hash % span) as u16
}

/// Escucha en el loopback, en el puerto preferido o el primero libre cerca de él.
///
/// `localhost` puede resolverse a `::1` o a `127.0.0.1`, y el navegador prueba el primero
/// que le da el sistema: si en ESE hubiera otro programa escuchando en el mismo puerto, la
/// página le hablaría a él. Por eso se toman las dos direcciones o se busca otro puerto. Sin
/// IPv6 en la máquina alcanza con la de IPv4. Devuelve también si quedó escuchando en `::1`.
async fn bind_loopback(preferred: u16) -> Result<(Vec<TcpListener>, u16, bool), String> {
    let near = (0..8u16).map(|i| preferred + i).filter(|p| PREFERRED_PORTS.contains(p));
    for port in near.chain(std::iter::repeat_n(0, 4)) {
        let Ok(v4) = TcpListener::bind(("127.0.0.1", port)).await else { continue };
        let port = v4.local_addr().map_err(|e| e.to_string())?.port();
        match TcpListener::bind(("::1", port)).await {
            Ok(v6) => return Ok((vec![v4, v6], port, true)),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(_) => return Ok((vec![v4], port, false)),
        }
    }
    Err("no se encontró un puerto libre para la vista previa".to_string())
}

async fn start_proxy(url: &reqwest::Url) -> Result<Proxy, String> {
    let target_origin = url.origin().ascii_serialization();
    let host = url.host_str().ok_or("la URL no tiene host")?.to_string();
    let port = url.port_or_known_default().ok_or("la URL no tiene puerto")?;
    let host_header = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };

    let (listeners, local_port, ipv6) = bind_loopback(preferred_port(&target_origin)).await?;
    let serve_host = match proxy_host(&host) {
        "[::1]" if !ipv6 => "127.0.0.1",
        other => other,
    };
    let proxy_origin = format!("http://{serve_host}:{local_port}");

    let client = reqwest::Client::builder()
        // Las redirecciones las sigue el iframe (con `Location` reescrito): siguiéndolas
        // acá, la barra de direcciones mostraría una URL que no es la que se ve.
        .redirect(reqwest::redirect::Policy::none())
        // Un servidor de desarrollo con HTTPS casi siempre usa un certificado propio. Solo
        // se acepta para hosts locales: para un sitio de verdad sería abrirle la puerta a
        // un intermediario.
        .danger_accept_invalid_certs(is_local_host(&host))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let log = Arc::new(ProxyLog::default());
    let mocks = Arc::new(Mocks::default());
    let ctx = Arc::new(Ctx {
        mocks: mocks.clone(),
        log: log.clone(),
        is_http: url.scheme() == "http",
        proxy_origin: proxy_origin.clone(),
        target_origin,
        target_host: host,
        target_port: port,
        host_header,
        client,
    });

    // `tokio::spawn` y no el runtime de Tauri: esto ya corre adentro de un comando async,
    // y el listener tiene que vivir en el mismo runtime donde se creó.
    for listener in listeners {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                let ctx = ctx.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let ctx = ctx.clone();
                        async move { Ok::<_, Infallible>(handle(req, ctx).await) }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
    }

    Ok(Proxy { port: local_port, origin: proxy_origin, log, mocks })
}

/// Resuelve qué poner en el iframe para mostrar `url`, levantando su proxy si hace falta.
/// `picker` es el script del selector ya compilado.
#[tauri::command]
pub async fn preview_resolve(url: String, picker: String) -> Result<PreviewTarget, String> {
    // Uno vacío no pisa el que ya hay: una pestaña que se abre antes de que el script
    // termine de cargar no le puede sacar el selector a las demás.
    if !picker.is_empty() {
        if let Ok(mut current) = PICKER.write() {
            *current = picker;
        }
    }
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL inválida: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Solo se pueden abrir direcciones http o https".to_string());
    }
    let target_origin = parsed.origin().ascii_serialization();

    let proxy_origin = {
        let mut proxies = PROXIES.lock().await;
        match proxies.get(&target_origin) {
            Some(proxy) => proxy.origin.clone(),
            None => {
                let proxy = start_proxy(&parsed).await?;
                let origin = proxy.origin.clone();
                proxies.insert(target_origin.clone(), proxy);
                origin
            }
        }
    };

    let mut rest = parsed.path().to_string();
    if let Some(q) = parsed.query() {
        rest.push('?');
        rest.push_str(q);
    }
    if let Some(f) = parsed.fragment() {
        rest.push('#');
        rest.push_str(f);
    }
    Ok(PreviewTarget { proxied_url: format!("{proxy_origin}{rest}"), proxy_origin, target_origin })
}

/// El log del proxy que sirve `proxy_origin` (`http://localhost:<puerto>`).
async fn log_for(proxy_origin: &str) -> Result<Arc<ProxyLog>, String> {
    let port: u16 = proxy_origin
        .rsplit(':')
        .next()
        .and_then(|p| p.trim_end_matches('/').parse().ok())
        .ok_or_else(|| format!("'{proxy_origin}' no es el origen de un proxy"))?;
    PROXIES
        .lock()
        .await
        .values()
        .find(|p| p.port == port)
        .map(|p| p.log.clone())
        .ok_or_else(|| format!("No hay ningún proxy en el puerto {port}"))
}

/// Las reglas simuladas del proxy que sirve `proxy_origin`.
async fn mocks_for(proxy_origin: &str) -> Result<Arc<Mocks>, String> {
    let port: u16 = proxy_origin
        .rsplit(':')
        .next()
        .and_then(|p| p.trim_end_matches('/').parse().ok())
        .ok_or_else(|| format!("'{proxy_origin}' no es el origen de un proxy"))?;
    PROXIES
        .lock()
        .await
        .values()
        .find(|p| p.port == port)
        .map(|p| p.mocks.clone())
        .ok_or_else(|| format!("No hay ningún proxy en el puerto {port}"))
}

/// Hace que el servidor conteste otra cosa para una URL (ver `preview::mocks`).
#[tauri::command]
pub async fn preview_add_mock(proxy_origin: String, mock: Mock) -> Result<Mock, String> {
    mocks_for(&proxy_origin).await?.add(mock)
}

#[tauri::command]
pub async fn preview_list_mocks(proxy_origin: String) -> Result<Vec<Mock>, String> {
    Ok(mocks_for(&proxy_origin).await?.list())
}

/// Borra una regla, o todas si no se nombra ninguna.
#[tauri::command]
pub async fn preview_clear_mocks(proxy_origin: String, id: Option<String>) -> Result<usize, String> {
    Ok(mocks_for(&proxy_origin).await?.clear(id.as_deref()))
}

/// Los pedidos que pasaron por el proxy después de `since`.
#[tauri::command]
pub async fn preview_network(proxy_origin: String, since: u64) -> Result<NetPage, String> {
    Ok(log_for(&proxy_origin).await?.since(since))
}

/// Todo lo que se sabe de un pedido: cabeceras, cuerpos y tiempos. `None` si ya no está.
#[tauri::command]
pub async fn preview_request(proxy_origin: String, seq: u64) -> Result<Option<RequestDetail>, String> {
    Ok(log_for(&proxy_origin).await?.detail(seq))
}

#[tauri::command]
pub async fn preview_clear_network(proxy_origin: String) -> Result<(), String> {
    log_for(&proxy_origin).await?.clear_network();
    Ok(())
}

/// Las cookies que puso el servidor y las que el navegador le está mandando.
#[tauri::command]
pub async fn preview_cookies(proxy_origin: String) -> Result<CookieReport, String> {
    Ok(log_for(&proxy_origin).await?.cookies(now_ms()))
}

/// Los puertos que usan por defecto los servidores de desarrollo más comunes: Next/CRA
/// (3000), Vite (5173/5174 y 4173 el preview), Angular (4200), Astro (4321), Django/Rails
/// y compañía (8000, 8080…).
const DEV_PORTS: &[u16] = &[3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

/// Qué servidores de desarrollo están escuchando en esta máquina, para ofrecerlos al abrir
/// un navegador vacío en vez de hacer tipear un puerto que probablemente ya está a la vista.
///
/// En las dos direcciones del loopback: Vite y Node ≥ 17 escuchan en `localhost`, que en
/// muchas máquinas es solo `::1`, y probando únicamente `127.0.0.1` no se los encontraba.
#[tauri::command]
pub async fn preview_detect_servers() -> Vec<String> {
    let listening = |addr: &'static str, port: u16| async move {
        tokio::time::timeout(Duration::from_millis(250), TcpStream::connect((addr, port)))
            .await
            .is_ok_and(|r| r.is_ok())
    };
    let probes = DEV_PORTS.iter().map(|&port| async move {
        let open = listening("127.0.0.1", port).await || listening("::1", port).await;
        open.then(|| format!("http://localhost:{port}"))
    });
    futures_util::future::join_all(probes).await.into_iter().flatten().collect()
}
