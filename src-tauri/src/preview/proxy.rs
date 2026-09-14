//! El servidor del proxy: uno por origen de destino, en `127.0.0.1` y un puerto libre.
//!
//! Uno por origen (y no uno solo con el destino en la ruta) porque así las rutas absolutas
//! de la página (`/assets/app.js`, `/api/login`) siguen funcionando sin reescribir nada:
//! para el iframe, el proxy ES el servidor.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderValue, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, ORIGIN, REFERER, SET_COOKIE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use super::rewrite::{
    inject_picker, is_local_host, parse_response_head, rewrite_location, rewrite_origin_value,
    skip_request_header, skip_response_header, strip_cookie_domain, PICKER_PATH,
};

/// El script del selector. Lo compila y lo manda la app (`src/features/browser/picker.ts`)
/// en cada `preview_resolve`: así el backend no carga una copia de código de frontend que
/// pueda quedar desactualizada, y en desarrollo un cambio al selector se ve sin recompilar
/// Rust.
static PICKER: LazyLock<RwLock<String>> = LazyLock::new(|| RwLock::new(String::new()));

type Body = BoxBody<Bytes, std::io::Error>;

/// Origen de destino → puerto del proxy que lo atiende. Viven lo que vive la app: abrir
/// otra vez el mismo proyecto reusa el mismo proxy, y con él sus cookies.
static PROXIES: LazyLock<Mutex<HashMap<String, u16>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
        "<!doctype html><meta charset=utf-8><title>{status}</title>\
         <body style=\"font:14px system-ui;padding:40px;color:#6b7280;background:transparent\">\
         <p style=\"font-weight:600;color:#374151\">No se pudo conectar con {}</p>\
         <p>¿Está corriendo el servidor?</p><pre style=\"white-space:pre-wrap\">{}</pre>",
        escape(target),
        escape(detail)
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(full(html))
        .expect("respuesta de error válida")
}

fn is_websocket(req: &Request<Incoming>) -> bool {
    req.headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn handle(req: Request<Incoming>, ctx: Arc<Ctx>) -> Response<Body> {
    if req.uri().path() == PICKER_PATH {
        return Response::builder()
            .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
            .header("cache-control", "no-store")
            .body(full(PICKER.read().map(|p| p.clone()).unwrap_or_default()))
            .expect("respuesta del selector válida");
    }
    if is_websocket(&req) {
        return match websocket(req, &ctx).await {
            Ok(resp) => resp,
            Err(e) => error_page(502, &ctx.target_origin, &e),
        };
    }
    match forward(req, &ctx).await {
        Ok(resp) => resp,
        Err(e) => error_page(502, &ctx.target_origin, &e),
    }
}

async fn forward(req: Request<Incoming>, ctx: &Ctx) -> Result<Response<Body>, String> {
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}{}", ctx.target_origin, path);

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in req.headers() {
        if skip_request_header(name.as_str()) {
            continue;
        }
        if *name == ORIGIN || *name == REFERER {
            if let Ok(text) = value.to_str() {
                let rewritten = rewrite_origin_value(text, &ctx.proxy_origin, &ctx.target_origin);
                if let Ok(v) = HeaderValue::from_str(&rewritten) {
                    headers.append(name.clone(), v);
                }
                continue;
            }
        }
        headers.append(name.clone(), value.clone());
    }

    let method = req.method().clone();
    let body = req.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();

    let upstream = ctx
        .client
        .request(method, &url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = upstream.status();
    let content_type = upstream.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let encoded = upstream
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|e| !e.eq_ignore_ascii_case("identity"));
    let is_html = content_type.to_ascii_lowercase().starts_with("text/html") && !encoded;

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream.headers() {
        if skip_response_header(name.as_str()) || (is_html && *name == CONTENT_LENGTH) {
            continue;
        }
        let value = match (name, value.to_str()) {
            (n, Ok(text)) if *n == LOCATION => {
                HeaderValue::from_str(&rewrite_location(text, &ctx.target_origin, &ctx.proxy_origin))
                    .unwrap_or_else(|_| value.clone())
            }
            (n, Ok(text)) if *n == SET_COOKIE => {
                HeaderValue::from_str(&strip_cookie_domain(text)).unwrap_or_else(|_| value.clone())
            }
            _ => value.clone(),
        };
        builder = builder.header(name, value);
    }

    if is_html {
        let bytes = upstream.bytes().await.map_err(|e| e.to_string())?;
        // Un HTML que no es UTF-8 se deja pasar sin selector antes que corromperlo.
        let body = match std::str::from_utf8(&bytes) {
            Ok(text) => full(inject_picker(text)),
            Err(_) => full(bytes),
        };
        return builder.body(body).map_err(|e| e.to_string());
    }

    // Todo lo demás pasa como stream: un Server-Sent Events del live reload nunca termina,
    // y leerlo entero antes de devolverlo lo dejaría colgado.
    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(std::io::Error::other);
    builder.body(StreamBody::new(stream).boxed()).map_err(|e| e.to_string())
}

/// El WebSocket del recargado en caliente (Vite, Next, webpack). Se reenvía el pedido de
/// upgrade al servidor y, si acepta, se conectan las dos puntas byte a byte.
async fn websocket(mut req: Request<Incoming>, ctx: &Ctx) -> Result<Response<Body>, String> {
    if !ctx.is_http {
        return Err("La vista previa todavía no reenvía WebSockets seguros (wss).".to_string());
    }
    let on_upgrade = hyper::upgrade::on(&mut req);
    let mut upstream = TcpStream::connect((ctx.target_host.as_str(), ctx.target_port))
        .await
        .map_err(|e| e.to_string())?;

    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let mut head = format!("{} {} HTTP/1.1\r\nhost: {}\r\n", req.method(), path, ctx.host_header);
    for (name, value) in req.headers() {
        if *name == hyper::header::HOST {
            continue;
        }
        let Ok(text) = value.to_str() else { continue };
        let text = if *name == ORIGIN {
            rewrite_origin_value(text, &ctx.proxy_origin, &ctx.target_origin)
        } else {
            text.to_string()
        };
        head.push_str(&format!("{}: {}\r\n", name.as_str(), text));
    }
    head.push_str("\r\n");
    upstream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = upstream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("el servidor cerró la conexión".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return Err("la cabecera de la respuesta es demasiado larga".to_string());
        }
    };
    let (status, headers) = parse_response_head(&String::from_utf8_lossy(&buf[..header_end]))
        .ok_or("respuesta inválida del servidor")?;
    let leftover = buf[header_end..].to_vec();

    let mut builder = Response::builder().status(status);
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    if status != 101 {
        return builder.body(full(leftover)).map_err(|e| e.to_string());
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
    builder.body(full(Bytes::new())).map_err(|e| e.to_string())
}

async fn start_proxy(url: &reqwest::Url) -> Result<u16, String> {
    let target_origin = url.origin().ascii_serialization();
    let host = url.host_str().ok_or("la URL no tiene host")?.to_string();
    let port = url.port_or_known_default().ok_or("la URL no tiene puerto")?;
    let host_header = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

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

    let ctx = Arc::new(Ctx {
        is_http: url.scheme() == "http",
        proxy_origin: format!("http://127.0.0.1:{local_port}"),
        target_origin,
        target_host: host,
        target_port: port,
        host_header,
        client,
    });

    // `tokio::spawn` y no el runtime de Tauri: esto ya corre adentro de un comando async,
    // y el listener tiene que vivir en el mismo runtime donde se creó.
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

    Ok(local_port)
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

    let port = {
        let mut proxies = PROXIES.lock().await;
        match proxies.get(&target_origin) {
            Some(port) => *port,
            None => {
                let port = start_proxy(&parsed).await?;
                proxies.insert(target_origin.clone(), port);
                port
            }
        }
    };

    let proxy_origin = format!("http://127.0.0.1:{port}");
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

/// Los puertos que usan por defecto los servidores de desarrollo más comunes: Next/CRA
/// (3000), Vite (5173/5174 y 4173 el preview), Angular (4200), Astro (4321), Django/Rails
/// y compañía (8000, 8080…).
const DEV_PORTS: &[u16] = &[3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

/// Qué servidores de desarrollo están escuchando en esta máquina, para ofrecerlos al abrir
/// un navegador vacío en vez de hacer tipear un puerto que probablemente ya está a la vista.
#[tauri::command]
pub async fn preview_detect_servers() -> Vec<String> {
    let probes = DEV_PORTS.iter().map(|&port| async move {
        let open = tokio::time::timeout(Duration::from_millis(250), TcpStream::connect(("127.0.0.1", port)))
            .await
            .is_ok_and(|r| r.is_ok());
        open.then(|| format!("http://localhost:{port}"))
    });
    futures_util::future::join_all(probes).await.into_iter().flatten().collect()
}
