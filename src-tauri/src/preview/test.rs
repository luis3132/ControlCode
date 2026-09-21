use super::rewrite::{
    inject_picker, is_local_host, is_own_host, parse_response_head, rewrite_location, rewrite_origin_value,
    skip_request_header, skip_response_header,
};

const TAG: &str = r#"<script src="/__controlcode__/picker.js"></script>"#;

#[test]
fn el_selector_va_justo_despues_de_head() {
    let html = "<!doctype html><html lang=\"es\"><head><title>x</title></head><body></body></html>";
    let out = inject_picker(html);
    assert!(out.contains(&format!("<head>{TAG}<title>")), "{out}");
    assert_eq!(out.matches(TAG).count(), 1);
}

#[test]
fn header_no_se_confunde_con_head() {
    // Una página sin <head> explícito pero con <header>: el script no puede terminar
    // adentro del header del sitio.
    let html = "<html><body><header>menú</header></body></html>";
    let out = inject_picker(html);
    assert!(out.starts_with(&format!("<html>{TAG}")), "{out}");
}

#[test]
fn head_con_atributos_y_mayusculas() {
    let out = inject_picker("<HTML><HEAD data-x=\"1\">\n<meta charset=utf-8></HEAD></HTML>");
    assert!(out.contains(&format!("<HEAD data-x=\"1\">{TAG}")), "{out}");
}

#[test]
fn un_fragmento_sin_estructura_igual_recibe_el_selector() {
    assert_eq!(inject_picker("<p>hola</p>"), format!("{TAG}<p>hola</p>"));
}

#[test]
fn las_redirecciones_al_servidor_vuelven_al_proxy() {
    let t = "http://localhost:5173";
    let p = "http://127.0.0.1:40111";
    assert_eq!(rewrite_location("http://localhost:5173/login?next=/", t, p), "http://127.0.0.1:40111/login?next=/");
    assert_eq!(rewrite_location("http://localhost:5173", t, p), "http://127.0.0.1:40111");
    // Relativas y a otros sitios quedan como están.
    assert_eq!(rewrite_location("/dashboard", t, p), "/dashboard");
    assert_eq!(rewrite_location("https://accounts.google.com/o/oauth2", t, p), "https://accounts.google.com/o/oauth2");
    // Un puerto que empieza igual no es el mismo origen.
    assert_eq!(rewrite_location("http://localhost:51730/x", t, p), "http://localhost:51730/x");
}

#[test]
fn el_servidor_ve_su_propio_origen() {
    let p = "http://127.0.0.1:40111";
    let t = "http://localhost:3000";
    assert_eq!(rewrite_origin_value("http://127.0.0.1:40111", p, t), "http://localhost:3000");
    assert_eq!(rewrite_origin_value("http://127.0.0.1:40111/checkout", p, t), "http://localhost:3000/checkout");
    assert_eq!(rewrite_origin_value("https://otro.sitio", p, t), "https://otro.sitio");
}

/// Lo que guarda la sesión de un proyecto solo se lo contesta a la página, pedido por el
/// nombre del proxy: un dominio re-apuntado a 127.0.0.1 llega con el suyo.
#[test]
fn el_estado_del_sitio_solo_se_pide_por_el_nombre_del_proxy() {
    assert!(is_own_host("localhost:41234", 41234));
    assert!(is_own_host("127.0.0.1:41234", 41234));
    assert!(is_own_host("[::1]:41234", 41234));
    assert!(is_own_host("LocalHost:41234", 41234));
    assert!(!is_own_host("localhost:41235", 41234));
    assert!(!is_own_host("evil.example:41234", 41234));
    assert!(!is_own_host("localhost", 41234));
}

#[test]
fn se_filtran_los_encabezados_que_impiden_mostrar_la_pagina() {
    assert!(skip_response_header("X-Frame-Options"));
    assert!(skip_response_header("content-security-policy"));
    assert!(skip_response_header("Transfer-Encoding"));
    assert!(!skip_response_header("content-type"));
    assert!(!skip_response_header("set-cookie"));

    // Sin compresión, para poder leer el HTML; sin host, lo pone el cliente.
    assert!(skip_request_header("Accept-Encoding"));
    assert!(skip_request_header("host"));
    assert!(!skip_request_header("cookie"));
    assert!(!skip_request_header("authorization"));
}

#[test]
fn solo_los_hosts_locales_aceptan_certificados_propios() {
    for local in ["localhost", "app.localhost", "127.0.0.1", "[::1]", "0.0.0.0", "mi-pc.local"] {
        assert!(is_local_host(local), "{local}");
    }
    for remoto in ["example.com", "localhost.evil.com", "192.168.1.10"] {
        assert!(!is_local_host(remoto), "{remoto}");
    }
}

#[test]
fn la_cabecera_del_upgrade_se_lee_entera() {
    let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    let (status, headers) = parse_response_head(head).unwrap();
    assert_eq!(status, 101);
    assert!(headers.contains(&("Sec-WebSocket-Accept".to_string(), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".to_string())));
    assert_eq!(headers.len(), 3);
}

// ── De punta a punta, con un servidor de mentira ─────────────────

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::proxy::preview_resolve;

/// Un "dev server" mínimo: HTML con cabeceras que prohíben el iframe, un JS, una
/// redirección absoluta y un WebSocket que devuelve lo que recibe.
async fn fake_dev_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let origin = req
                    .lines()
                    .find_map(|l| l.strip_prefix("origin: ").or_else(|| l.strip_prefix("Origin: ")))
                    .unwrap_or("")
                    .to_string();
                let cookie = req
                    .lines()
                    .find_map(|l| l.strip_prefix("cookie: ").or_else(|| l.strip_prefix("Cookie: ")))
                    .unwrap_or("")
                    .to_string();

                if path == "/ws" {
                    let head = format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Origin-Visto: {origin}\r\n\r\n"
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    let mut echo = [0u8; 64];
                    while let Ok(n) = sock.read(&mut echo).await {
                        if n == 0 || sock.write_all(&echo[..n]).await.is_err() {
                            break;
                        }
                    }
                    return;
                }

                let bare = path.split('?').next().unwrap_or("/");
                let (status, extra, body) = match bare {
                    // Devuelve el `Cookie` con que llegó: lo que el servidor ve de la sesión.
                    _ if bare.ends_with("/eco") => ("200 OK", "Content-Type: text/plain\r\n", cookie),
                    "/" => ("200 OK", "Content-Type: text/html; charset=utf-8\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\n",
                            "<html><head><title>Hola</title></head><body>hola</body></html>".to_string()),
                    "/app.js" => ("200 OK", "Content-Type: application/javascript\r\n", "console.log(1)".to_string()),
                    "/sesion" => ("200 OK", "Set-Cookie: sid=abc; Path=/app; HttpOnly; SameSite=Lax\r\nSet-Cookie: tema=oscuro; Domain=localhost\r\n", String::new()),
                    "/login" => ("302 Found", &*Box::leak(format!("Location: http://127.0.0.1:{port}/panel\r\n").into_boxed_str()), String::new()),
                    "/api/datos" => ("201 Created", "Content-Type: application/json\r\nX-Request-Id: abc-123\r\n",
                                     format!("{{\"recibido\":{}}}", req.split("\r\n\r\n").nth(1).unwrap_or("").len())),
                    _ => ("404 Not Found", "", String::new()),
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    port
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn el_html_llega_con_el_selector_y_sin_las_trabas_para_mostrarse() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), "window.__picker=1".into())
        .await
        .unwrap();
    assert!(target.proxied_url.starts_with(&target.proxy_origin));

    let resp = client().get(&target.proxied_url).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert!(resp.headers().get("x-frame-options").is_none());
    assert!(resp.headers().get("content-security-policy").is_none());
    let html = resp.text().await.unwrap();
    assert!(html.contains(r#"<head><script src="/__controlcode__/picker.js"></script><title>"#), "{html}");

    let picker = client()
        .get(format!("{}/__controlcode__/picker.js", target.proxy_origin))
        .send().await.unwrap().text().await.unwrap();
    assert_eq!(picker, "window.__picker=1", "sirve el script que mandó la app");

    // Lo que no es HTML pasa intacto.
    let js = client().get(format!("{}/app.js", target.proxy_origin)).send().await.unwrap().text().await.unwrap();
    assert_eq!(js, "console.log(1)");
}

#[tokio::test(flavor = "multi_thread")]
async fn las_redirecciones_absolutas_vuelven_a_pasar_por_el_proxy() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let resp = client().get(format!("{}/login", target.proxy_origin)).send().await.unwrap();
    assert_eq!(resp.status(), 302);
    assert_eq!(
        resp.headers().get("location").unwrap().to_str().unwrap(),
        format!("{}/panel", target.proxy_origin)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn el_mismo_origen_reusa_su_proxy() {
    let port = fake_dev_server().await;
    let a = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let b = preview_resolve(format!("http://127.0.0.1:{port}/otra?x=1#y"), String::new()).await.unwrap();
    assert_eq!(a.proxy_origin, b.proxy_origin);
    assert_eq!(b.proxied_url, format!("{}/otra?x=1#y", b.proxy_origin));
}

#[tokio::test(flavor = "multi_thread")]
async fn el_websocket_del_recargado_en_caliente_atraviesa_el_proxy() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let proxy_port: u16 = target.proxy_origin.rsplit(':').next().unwrap().parse().unwrap();

    let mut sock = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let handshake = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{proxy_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: {}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        target.proxy_origin
    );
    sock.write_all(handshake.as_bytes()).await.unwrap();

    let mut buf = vec![0u8; 4096];
    let n = sock.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]);
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    // El servidor tiene que haber visto SU origen, no el del proxy: Vite rechaza el socket
    // si no coincide.
    assert!(head.contains(&format!("http://127.0.0.1:{port}")), "{head}");

    sock.write_all(b"ping").await.unwrap();
    let mut echo = [0u8; 4];
    sock.read_exact(&mut echo).await.unwrap();
    assert_eq!(&echo, b"ping");
}

// ── El log del proxy: red y cookies ──────────────────────────────

use super::log::{
    parse_cookie_header, parse_http_date, parse_set_cookie, Begin, ErrorKind, Finish, Head, Header, HeaderNote,
    ProxyLog, MAX_RESPONSE_BODY,
};
use super::proxy::{preferred_port, preview_cookies, preview_network, preview_request, proxy_host};

#[test]
fn las_fechas_http_se_leen_en_sus_dos_grafias() {
    assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
    assert_eq!(parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"), Some(1_445_412_480));
    assert_eq!(parse_http_date("Wed, 21-Oct-2015 07:28:00 GMT"), Some(1_445_412_480));
    assert_eq!(parse_http_date("mañana"), None);
}

#[test]
fn un_set_cookie_trae_los_atributos_que_explican_por_que_no_llega() {
    let c = parse_set_cookie("sid=abc=def; Path=/app; HttpOnly; Secure; SameSite=Strict; Max-Age=60", 1000).unwrap();
    assert_eq!((c.name.as_str(), c.value.as_str()), ("sid", "abc=def"));
    assert_eq!(c.path.as_deref(), Some("/app"));
    assert!(c.http_only && c.secure);
    assert_eq!(c.same_site.as_deref(), Some("Strict"));
    assert_eq!(c.expires_at, Some(1060));

    // Max-Age gana sobre Expires, y Max-Age=0 es "borrala ya".
    let borrar = parse_set_cookie("sid=; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=0", 1000).unwrap();
    assert_eq!(borrar.expires_at, Some(0));
    assert!(parse_set_cookie("sin-igual", 0).is_none());
}

#[test]
fn la_cabecera_cookie_se_parte_en_pares() {
    let cookies = parse_cookie_header("a=1; b=x=y;  ; c");
    let names: Vec<_> = cookies.iter().map(|c| (c.name.as_str(), c.value.as_str())).collect();
    assert_eq!(names, vec![("a", "1"), ("b", "x=y")]);
}

/// Un pedido entero por el log: llega, responde y termina.
fn record(log: &ProxyLog, url: &str, now: i64) -> u64 {
    let seq = log.begin(
        Begin {
            method: "GET",
            url: url.to_string(),
            cookie_header: None,
            request_headers: vec![],
            request_body: &[],
            request_content_type: None,
            websocket: false,
        },
        now,
    );
    log.head(seq, head(200));
    log.finish(seq, Finish { body: vec![], body_size: 0, truncated: false, encoding: None, duration_ms: 1, error: None });
    seq
}

fn head(status: u16) -> Head {
    Head {
        status,
        headers: vec![],
        http_version: Some("HTTP/1.1".into()),
        remote_address: None,
        content_type: None,
        content_length: None,
        ttfb_ms: 1,
    }
}

#[test]
fn el_log_se_lee_por_partes_y_avisa_si_se_perdio_algo() {
    let log = ProxyLog::default();
    for i in 0..3 {
        record(&log, &format!("http://x/{i}"), 0);
    }
    let first = log.since(0);
    assert_eq!(first.entries.len(), 3);
    assert!(!first.dropped);

    record(&log, "http://x/3", 0);
    let second = log.since(first.next);
    assert_eq!(second.entries.iter().map(|e| e.url.as_str()).collect::<Vec<_>>(), vec!["http://x/3"]);

    // Más de lo que entra: quien leyó hasta el 4 se perdió entradas y tiene que saberlo.
    for i in 0..2000 {
        record(&log, &format!("http://x/n{i}"), 0);
    }
    assert!(log.since(second.next).dropped);
}

/// El panel muestra un pedido en curso y lo tiene que ver terminar: la entrada vuelve a
/// llegar cuando cambia, con el mismo `seq`.
#[test]
fn un_pedido_pendiente_vuelve_a_llegar_cuando_termina() {
    let log = ProxyLog::default();
    let seq = log.begin(
        Begin {
            method: "POST",
            url: "http://x/api".into(),
            cookie_header: None,
            request_headers: vec![Header::new("content-type", "application/json")],
            request_body: br#"{"a":1}"#,
            request_content_type: Some("application/json".into()),
            websocket: false,
        },
        0,
    );
    let pending = log.since(0);
    assert_eq!(pending.entries.len(), 1);
    assert!(!pending.entries[0].finished && pending.entries[0].status.is_none());

    log.head(seq, head(404));
    log.finish(seq, Finish { body: b"nope".to_vec(), body_size: 4, truncated: false, encoding: None, duration_ms: 9, error: None });
    let done = log.since(pending.next);
    assert_eq!(done.entries.len(), 1);
    let entry = &done.entries[0];
    assert_eq!((entry.seq, entry.status, entry.status_text.as_deref()), (seq, Some(404), Some("Not Found")));
    assert!(entry.finished);
    assert_eq!((entry.size, entry.duration_ms, entry.ttfb_ms), (Some(4), 9, Some(1)));

    let detail = log.detail(seq).unwrap();
    assert_eq!(detail.request_body.unwrap().text.as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(detail.response_body.unwrap().text.as_deref(), Some("nope"));
}

#[test]
fn un_cuerpo_binario_viaja_en_base64_y_uno_cortado_sigue_siendo_texto() {
    let log = ProxyLog::default();
    let seq = record(&log, "http://x/img", 0);
    log.finish(seq, Finish { body: vec![0xff, 0x00, 0x89], body_size: 3, truncated: false, encoding: None, duration_ms: 1, error: None });
    let body = log.detail(seq).unwrap().response_body.unwrap();
    assert_eq!((body.text, body.base64.as_deref()), (None, Some("/wCJ")));

    // "ñ" son dos bytes: cortar entre los dos no lo vuelve binario.
    let seq = record(&log, "http://x/txt", 0);
    log.finish(seq, Finish { body: "añ".as_bytes()[..2].to_vec(), body_size: 50, truncated: true, encoding: None, duration_ms: 1, error: None });
    let body = log.detail(seq).unwrap().response_body.unwrap();
    assert_eq!(body.text.as_deref(), Some("a"));
    assert!(body.truncated && body.size == 50);
}

#[test]
fn pasado_el_presupuesto_se_sueltan_los_cuerpos_mas_viejos_y_no_el_ultimo() {
    let log = ProxyLog::default();
    let seqs: Vec<u64> = (0..70)
        .map(|i| {
            let seq = record(&log, &format!("http://x/{i}"), 0);
            log.finish(seq, Finish {
                body: vec![b'a'; MAX_RESPONSE_BODY], body_size: MAX_RESPONSE_BODY as u64,
                truncated: false, encoding: None, duration_ms: 1, error: None,
            });
            seq
        })
        .collect();
    let first = log.detail(seqs[0]).unwrap().response_body.unwrap();
    assert!(first.evicted && first.text.is_none(), "el más viejo se soltó");
    assert_eq!(first.size, MAX_RESPONSE_BODY as u64, "pero se sigue sabiendo cuánto medía");
    let last = log.detail(*seqs.last().unwrap()).unwrap().response_body.unwrap();
    assert!(!last.evicted && last.text.is_some());
}

/// Un pedido de la página al proxy sobre el estado del sitio, como lo hace el runtime.
fn own(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("x-controlcode", "1")
}

/// El proxy es el frasco de cookies del sitio: el iframe no recibe ningún `Set-Cookie`, y lo
/// que llega al servidor sale de lo guardado, no de lo que mande el navegador.
#[tokio::test(flavor = "multi_thread")]
async fn las_cookies_las_guarda_el_proxy_y_no_el_navegador() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let before = preview_network(target.proxy_origin.clone(), 0).await.unwrap().next;
    let c = client();
    let at = |path: &str| format!("{}{path}", target.proxy_origin);

    let resp = c.get(at("/sesion")).send().await.unwrap();
    assert!(resp.headers().get("set-cookie").is_none(), "el iframe no recibe cookies: {:?}", resp.headers());
    assert!(resp.headers().get("x-controlcode-jar").is_some(), "la página se entera de que cambió el frasco");

    // Lo que tenga guardado el navegador para `localhost` no llega: es de cualquier puerto.
    let seen = c.get(at("/app/eco")).header("cookie", "intrusa=1").send().await.unwrap().text().await.unwrap();
    assert_eq!(seen, "sid=abc; tema=oscuro", "path más largo primero");
    // `sid` es de `/app`: a la raíz no va.
    assert_eq!(c.get(at("/eco")).send().await.unwrap().text().await.unwrap(), "tema=oscuro");

    let cookies = preview_cookies(target.proxy_origin.clone()).await.unwrap();
    let sid = cookies.set.iter().find(|c| c.name == "sid").expect("la HttpOnly se ve");
    assert!(sid.http_only);
    assert_eq!(sid.path.as_deref(), Some("/app"));
    assert_eq!(cookies.sent.unwrap().cookies.len(), 1, "el último pedido llevó solo `tema`");

    // El panel de red muestra lo que pasó de verdad en cada punta.
    let entries = preview_network(target.proxy_origin.clone(), before).await.unwrap().entries;
    let seq = |suffix: &str| entries.iter().find(|e| e.url.ends_with(suffix)).unwrap().seq;
    let sesion = preview_request(target.proxy_origin.clone(), seq("/sesion")).await.unwrap().unwrap();
    let kept: Vec<_> = sesion.response_headers.iter().filter(|h| h.name == "set-cookie").collect();
    assert_eq!(kept.len(), 2);
    assert!(kept.iter().all(|h| h.note == Some(HeaderNote::Kept)), "{kept:?}");
    let eco = preview_request(target.proxy_origin.clone(), seq("/app/eco")).await.unwrap().unwrap();
    let sent = eco.request_headers.iter().find(|h| h.name == "cookie").unwrap();
    assert_eq!((sent.value.as_str(), sent.note), ("sid=abc; tema=oscuro", Some(HeaderNote::Rewritten)));

    // Borrar una cookie la saca del frasco, `HttpOnly` incluida.
    let clear = own(c.get(at("/__controlcode__/cookies/clear?name=sid"))).send().await.unwrap();
    assert_eq!(clear.status(), 204);
    assert!(preview_cookies(target.proxy_origin.clone()).await.unwrap().set.iter().all(|c| c.name != "sid"));
    assert_eq!(c.get(at("/app/eco")).send().await.unwrap().text().await.unwrap(), "tema=oscuro");

    // Lo propio del proxy no se anota como tráfico de la página.
    let last = preview_network(target.proxy_origin.clone(), 0).await.unwrap().entries;
    assert!(last.iter().all(|e| !e.url.contains("__controlcode__")), "{last:?}");
}

/// `document.cookie` se resuelve contra el frasco: ve lo que no es `HttpOnly`, y lo que
/// escribe viaja en los pedidos siguientes.
#[tokio::test(flavor = "multi_thread")]
async fn document_cookie_lee_y_escribe_el_frasco_del_sitio() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let c = client();
    let at = |path: &str| format!("{}{path}", target.proxy_origin);
    c.get(at("/sesion")).send().await.unwrap();

    let read = |path: &str| {
        let url = at(&format!("/__controlcode__/cookie?path={path}"));
        let c = c.clone();
        async move { own(c.get(url)).send().await.unwrap().json::<serde_json::Value>().await.unwrap() }
    };
    let view = read("%2Fapp%2Fpanel").await;
    assert_eq!(view["cookie"], "tema=oscuro", "la HttpOnly no se ve desde la página");

    // Un script no puede pisar una HttpOnly (si pudiera, leería la sesión)…
    let write = |path: &str, line: &str| {
        let url = at(&format!("/__controlcode__/cookie?path={path}"));
        let (c, line) = (c.clone(), line.to_string());
        async move { own(c.post(url)).body(line).send().await.unwrap().json::<serde_json::Value>().await.unwrap() }
    };
    write("%2Fapp%2Fpanel", "sid=robada; path=/app").await;
    assert_eq!(c.get(at("/app/eco")).send().await.unwrap().text().await.unwrap(), "sid=abc; tema=oscuro");
    // …pero sí poner las suyas, que contesta en el acto.
    let after = write("%2F", "idioma=es; max-age=3600").await;
    assert_eq!(after["cookie"], "tema=oscuro; idioma=es");
    assert!(after["v"].as_u64().unwrap() > view["v"].as_u64().unwrap(), "la versión sube con el cambio");
    assert_eq!(c.get(at("/eco")).send().await.unwrap().text().await.unwrap(), "tema=oscuro; idioma=es");
    // Y borrarlas como siempre: vencidas.
    write("%2F", "idioma=; max-age=0").await;
    assert_eq!(read("%2F").await["cookie"], "tema=oscuro");
}

/// Dos proyectos en el mismo host y distinto puerto tienen cada uno su sesión. Con las
/// cookies del motor —que no separan por puerto— se pisaban.
#[tokio::test(flavor = "multi_thread")]
async fn cada_puerto_tiene_sus_propias_cookies() {
    let (a, b) = (fake_dev_server().await, fake_dev_server().await);
    let pa = preview_resolve(format!("http://127.0.0.1:{a}/"), String::new()).await.unwrap().proxy_origin;
    let pb = preview_resolve(format!("http://127.0.0.1:{b}/"), String::new()).await.unwrap().proxy_origin;
    let c = client();
    c.get(format!("{pa}/sesion")).send().await.unwrap();
    assert_eq!(c.get(format!("{pa}/eco")).send().await.unwrap().text().await.unwrap(), "tema=oscuro");
    assert_eq!(c.get(format!("{pb}/eco")).send().await.unwrap().text().await.unwrap(), "");
    assert!(preview_cookies(pb).await.unwrap().set.is_empty());
}

/// El estado del sitio tiene sesiones adentro: sin la cabecera del runtime, o pedido con
/// otro nombre que el del proxy, no se contesta.
#[tokio::test(flavor = "multi_thread")]
async fn el_estado_del_sitio_no_se_le_da_a_cualquiera() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let c = client();
    c.get(format!("{}/sesion", target.proxy_origin)).send().await.unwrap();
    let url = format!("{}/__controlcode__/cookie?path=%2F", target.proxy_origin);
    assert_eq!(c.get(&url).send().await.unwrap().status(), 403, "sin la cabecera del runtime");
    let rebound = own(c.get(&url)).header("host", "evil.example").send().await.unwrap();
    assert_eq!(rebound.status(), 403, "por otro nombre");
    let storage = c.post(format!("{}/__controlcode__/storage", target.proxy_origin)).body("{}").send().await.unwrap();
    assert_eq!(storage.status(), 403);
    assert_eq!(own(c.get(&url)).send().await.unwrap().status(), 200);
}

/// La primera página después de arrancar puede reponer el storage que el motor perdió; en
/// cuanto la página manda el suyo, el del navegador es el que vale.
#[tokio::test(flavor = "multi_thread")]
async fn el_storage_se_guarda_y_se_repone_una_vez() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let c = client();
    let url = format!("{}/__controlcode__/storage", target.proxy_origin);
    // Recién abierto y sin nada guardado: no hay qué reponer.
    let empty: serde_json::Value = own(c.get(&url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(empty, serde_json::json!({ "local": null, "session": null }));

    let saved = own(c.post(&url))
        .body(r#"{"local":[["token","abc"]],"session":[["paso","2"]]}"#)
        .send().await.unwrap();
    assert_eq!(saved.status(), 204);
    let bad = own(c.post(&url)).body("no es json").send().await.unwrap();
    assert_eq!(bad.status(), 400);
    // En la misma ejecución no se repone: la página ya tiene el suyo.
    let again: serde_json::Value = own(c.get(&url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(again["local"], serde_json::Value::Null);
}

/// Lo que el panel necesita para depurar un pedido: las cabeceras de las dos puntas (con lo
/// que cambió la vista previa), los cuerpos, el código con su texto y los tiempos.
#[tokio::test(flavor = "multi_thread")]
async fn el_detalle_trae_cabeceras_cuerpos_y_lo_que_cambio_la_vista_previa() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let before = preview_network(target.proxy_origin.clone(), 0).await.unwrap().next;

    let c = client();
    c.get(format!("{}/", target.proxy_origin)).send().await.unwrap().text().await.unwrap();
    let created = c
        .post(format!("{}/api/datos?pagina=2", target.proxy_origin))
        .header("content-type", "application/json")
        .header("origin", target.proxy_origin.clone())
        .header("accept-encoding", "gzip")
        .body(r#"{"nombre":"Ana"}"#)
        .send().await.unwrap();
    assert_eq!(created.status(), 201);
    assert_eq!(created.text().await.unwrap(), r#"{"recibido":16}"#);
    c.get(format!("{}/no-existe", target.proxy_origin)).send().await.unwrap().text().await.unwrap();

    let entries = preview_network(target.proxy_origin.clone(), before).await.unwrap().entries;
    let find = |path: &str| entries.iter().filter(|e| e.url.ends_with(path)).max_by_key(|e| e.rev).unwrap().clone();

    let post = find("/api/datos?pagina=2");
    assert!(post.finished && post.error.is_none(), "{post:?}");
    assert_eq!((post.status, post.status_text.as_deref()), (Some(201), Some("Created")));
    let detail = preview_request(target.proxy_origin.clone(), post.seq).await.unwrap().unwrap();
    let request = |name: &str| detail.request_headers.iter().find(|h| h.name == name).cloned();
    assert_eq!(request("host").unwrap(), Header::noted("host", format!("127.0.0.1:{port}"), HeaderNote::Rewritten));
    assert_eq!(request("origin").unwrap(), Header::noted("origin", format!("http://127.0.0.1:{port}"), HeaderNote::Rewritten));
    assert_eq!(request("accept-encoding").unwrap().note, Some(HeaderNote::Removed));
    assert_eq!(request("content-type").unwrap().note, None);
    assert_eq!(detail.request_body.unwrap().text.as_deref(), Some(r#"{"nombre":"Ana"}"#));
    assert!(detail.response_headers.iter().any(|h| h.name == "x-request-id" && h.value == "abc-123"));
    assert_eq!(detail.response_body.unwrap().text.as_deref(), Some(r#"{"recibido":16}"#));
    assert_eq!(detail.http_version.as_deref(), Some("HTTP/1.1"));
    assert_eq!(detail.remote_address.as_deref(), Some(format!("127.0.0.1:{port}").as_str()));

    // Las cabeceras que la vista previa le saca al iframe se ven igual, marcadas.
    let html = preview_request(target.proxy_origin.clone(), find("/").seq).await.unwrap().unwrap();
    let xfo = html.response_headers.iter().find(|h| h.name == "x-frame-options").unwrap();
    assert_eq!((xfo.value.as_str(), xfo.note), ("DENY", Some(HeaderNote::Removed)));
    assert!(html.response_body.unwrap().text.unwrap().contains("<title>Hola</title>"), "el HTML como lo mandó el servidor");

    let missing = find("/no-existe");
    assert_eq!((missing.status, missing.status_text.as_deref()), (Some(404), Some("Not Found")));
}

#[tokio::test(flavor = "multi_thread")]
async fn un_servidor_apagado_se_anota_como_conexion_rechazada() {
    // Un puerto que se abre y se cierra: nadie escucha ahí.
    let port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let resp = client().get(format!("{}/api", target.proxy_origin)).send().await.unwrap();
    assert_eq!(resp.status(), 502);
    // La página de error trae el runtime como cualquier otra: la app se entera de que cargó y
    // un agente que navegó ahí ve el error enseguida, sin esperar a que se venza.
    assert!(resp.text().await.unwrap().contains(TAG));

    let entry = preview_network(target.proxy_origin.clone(), 0).await.unwrap().entries.pop().unwrap();
    assert!(entry.finished && entry.status.is_none());
    assert_eq!(entry.error_kind, Some(ErrorKind::ConnectionRefused), "{:?}", entry.error);
    assert!(entry.error.unwrap().to_ascii_lowercase().contains("refused"));
}

/// La página tiene el origen del proxy: tiene que ser el mismo tipo de loopback con que se
/// abrió el servidor, o un backend que acepta CORS de `localhost:*` rechaza todo.
#[test]
fn el_proxy_se_sirve_con_el_mismo_nombre_que_el_servidor() {
    assert_eq!(proxy_host("localhost"), "localhost");
    assert_eq!(proxy_host("127.0.0.1"), "127.0.0.1");
    assert_eq!(proxy_host("127.0.1.1"), "127.0.0.1");
    assert_eq!(proxy_host("[::1]"), "[::1]");
    assert_eq!(proxy_host("app.localhost"), "localhost");
    // Un servidor en otra máquina se sirve igual desde esta: como localhost.
    assert_eq!(proxy_host("192.168.1.40"), "localhost");
}

/// Con el mismo puerto en cada arranque, el origen de la página no cambia: se lo puede
/// agregar a una lista de CORS, y el storage que el motor sí conserve sigue siendo suyo.
#[test]
fn cada_servidor_tiene_siempre_el_mismo_puerto() {
    let a = preferred_port("http://localhost:5173");
    assert_eq!(a, preferred_port("http://localhost:5173"));
    assert_ne!(a, preferred_port("http://localhost:3000"));
    for origin in ["http://localhost:5173", "http://127.0.0.1:8080", "https://example.com"] {
        assert!((41_000..49_000).contains(&preferred_port(origin)), "{origin}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn un_servidor_abierto_como_localhost_se_ve_desde_localhost() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://localhost:{port}/"), String::new()).await.unwrap();
    assert!(target.proxy_origin.starts_with("http://localhost:"), "{}", target.proxy_origin);
    let proxy_port: u16 = target.proxy_origin.rsplit(':').next().unwrap().parse().unwrap();
    assert!((41_000..49_008).contains(&proxy_port), "{proxy_port}");

    // La página carga por `localhost`, resuelva a la dirección que resuelva.
    let html = client().get(&target.proxied_url).send().await.unwrap().text().await.unwrap();
    assert!(html.contains("<title>Hola</title>"), "{html}");

    // Otra ruta del mismo servidor usa el mismo proxy, con el mismo origen.
    let again = preview_resolve(format!("http://localhost:{port}/otra"), String::new()).await.unwrap();
    assert_eq!(again.proxy_origin, target.proxy_origin);
}

// ── Respuestas simuladas ─────────────────────────────────────────

use super::mocks::{matches, Mock, Mocks};

fn regla(url: &str) -> Mock {
    Mock {
        id: String::new(),
        method: None,
        url: url.into(),
        status: 500,
        body: String::new(),
        content_type: None,
        delay_ms: 0,
        times: None,
        hits: 0,
    }
}

#[test]
fn el_patron_de_una_regla_entiende_comodines() {
    assert!(matches("/api/login", "/api/login?next=/"));
    assert!(matches("*/users*", "/api/v2/users?page=1"));
    assert!(matches("/api/*/users", "/api/v2/users"));
    assert!(!matches("/api/*/users", "/api/v2/users/3"), "sin * final, tiene que cerrar");
    assert!(!matches("/api/login", "/api/logout"));
    assert!(!matches("", "/lo que sea"));
    // Sin comodín adelante, el patrón tiene que estar en alguna parte de la URL.
    assert!(matches("users", "/api/users"));
}

/// Gana la más nueva: se agrega una regla para cambiar lo que hacía la anterior, no para
/// quedar atrás de ella.
#[test]
fn la_regla_mas_nueva_gana_y_el_metodo_filtra() {
    let mocks = Mocks::default();
    mocks.add(Mock { status: 200, ..regla("/api/*") }).unwrap();
    mocks.add(Mock { status: 503, method: Some("post".into()), ..regla("/api/login") }).unwrap();

    assert_eq!(mocks.canned("POST", "/api/login").unwrap().status, 503);
    assert_eq!(mocks.canned("GET", "/api/login").unwrap().status, 200, "el método no coincide: cae a la otra");
    assert!(mocks.canned("GET", "/inicio").is_none());
}

/// "Que falle una sola vez" es lo que hace falta para probar un reintento.
#[test]
fn una_regla_con_tope_deja_de_valer_despues_de_usarse() {
    let mocks = Mocks::default();
    mocks.add(Mock { times: Some(1), ..regla("/api/x") }).unwrap();
    assert!(mocks.canned("GET", "/api/x").is_some());
    assert!(mocks.canned("GET", "/api/x").is_none());
    assert_eq!(mocks.list()[0].hits, 1);
}

#[test]
fn el_cuerpo_decide_el_tipo_y_una_regla_invalida_se_rechaza() {
    let mocks = Mocks::default();
    mocks.add(Mock { body: "{\"error\":\"no\"}".into(), ..regla("/api/y") }).unwrap();
    assert!(mocks.canned("GET", "/api/y").unwrap().content_type.starts_with("application/json"));

    assert!(mocks.add(regla(" ")).unwrap_err().contains("URL"));
    assert!(mocks.add(Mock { status: 42, ..regla("/z") }).unwrap_err().contains("código"));
    assert_eq!(mocks.clear(None), 1);
    assert!(mocks.list().is_empty());
}

/// De punta a punta: la regla contesta en lugar del servidor, y el panel de red lo ve como
/// un pedido más —marcado como simulado— y no como si el servidor hubiera contestado eso.
#[tokio::test(flavor = "multi_thread")]
async fn una_regla_contesta_en_lugar_del_servidor_y_queda_anotada() {
    let port = fake_dev_server().await;
    let target = preview_resolve(format!("http://127.0.0.1:{port}/"), String::new()).await.unwrap();
    let before = preview_network(target.proxy_origin.clone(), 0).await.unwrap().next;

    super::proxy::preview_add_mock(
        target.proxy_origin.clone(),
        Mock { status: 503, body: "{\"error\":\"caído\"}".into(), ..regla("/app.js") },
    )
    .await
    .unwrap();

    let resp = client().get(format!("{}/app.js", target.proxy_origin)).send().await.unwrap();
    assert_eq!(resp.status(), 503);
    assert_eq!(resp.headers().get("x-controlcode-mock").unwrap(), "1");
    assert_eq!(resp.text().await.unwrap(), "{\"error\":\"caído\"}");

    let page = preview_network(target.proxy_origin.clone(), before).await.unwrap();
    let entry = page.entries.last().expect("queda anotado");
    assert_eq!(entry.status, Some(503));
    assert!(entry.url.ends_with("/app.js"));

    // Borrada la regla, el servidor vuelve a contestar lo suyo.
    super::proxy::preview_clear_mocks(target.proxy_origin.clone(), None).await.unwrap();
    let real = client().get(format!("{}/app.js", target.proxy_origin)).send().await.unwrap();
    assert_eq!(real.text().await.unwrap(), "console.log(1)");
}

// ── Lo que se guarda de cada sitio ───────────────────────────────

use super::log::SetCookie;
use super::site::{default_path, file_name, path_matches, store_cookie, Site, StorageCopy};

fn site_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cc-site-{tag}-{}", uuid::Uuid::new_v4()))
}

fn cookie(line: &str, at: i64) -> SetCookie {
    let mut c = parse_set_cookie(line, at / 1000).unwrap();
    c.at = at;
    c
}

#[test]
fn el_path_de_una_cookie_sigue_el_rfc() {
    assert_eq!(default_path("/app/login?next=/"), "/app");
    assert_eq!(default_path("/login"), "/");
    assert_eq!(default_path("/"), "/");
    assert_eq!(default_path(""), "/");
    assert!(path_matches("/app", "/app"));
    assert!(path_matches("/app/panel?x=1", "/app"));
    assert!(path_matches("/app/panel", "/app/"));
    assert!(path_matches("/cualquiera", "/"));
    assert!(!path_matches("/application", "/app"), "un prefijo de texto no es un directorio");
    assert!(!path_matches("/", "/app"));
}

/// Un servidor borra una cookie mandándola vencida; si el frasco la siguiera teniendo, un
/// logout no cerraría nada.
#[test]
fn una_cookie_vencida_se_borra_del_frasco() {
    let mut jar = Vec::new();
    assert!(store_cookie(&mut jar, cookie("sid=1; Path=/", 5_000_000), "/login", false, 5_000));
    assert!(!store_cookie(&mut jar, cookie("sid=1; Path=/", 5_000_001), "/login", false, 5_000), "la misma no es un cambio");
    assert!(store_cookie(&mut jar, cookie("sid=; Path=/; Max-Age=0", 5_000_000), "/logout", false, 5_000));
    assert!(jar.is_empty());
    // Una vencida que no existía no cambia nada.
    assert!(!store_cookie(&mut jar, cookie("otra=; Max-Age=0", 5_000_000), "/", false, 5_000));
}

#[test]
fn un_script_no_toca_las_httponly() {
    let mut jar = Vec::new();
    store_cookie(&mut jar, cookie("sid=secreto; Path=/; HttpOnly", 0), "/", false, 0);
    assert!(!store_cookie(&mut jar, cookie("sid=robada; Path=/", 0), "/", true, 0));
    assert_eq!(jar[0].value, "secreto");
    // Y lo que pone un script nunca es HttpOnly, aunque lo pida.
    store_cookie(&mut jar, cookie("js=1; HttpOnly", 0), "/", true, 0);
    assert!(!jar.iter().find(|c| c.name == "js").unwrap().http_only);
}

#[test]
fn el_frasco_tiene_techo() {
    let mut jar = Vec::new();
    for i in 0..200 {
        store_cookie(&mut jar, cookie(&format!("c{i}=1"), i), "/", false, 0);
    }
    assert_eq!(jar.len(), 180);
    assert!(jar.iter().all(|c| c.name != "c0"), "se va la más vieja");
    assert!(jar.iter().any(|c| c.name == "c199"));
}

#[test]
fn el_archivo_de_cada_sitio_se_reconoce_y_no_choca() {
    assert!(file_name("http://localhost:5173").starts_with("http_localhost_5173-"));
    assert_ne!(file_name("http://a-b:1"), file_name("http://a_b:1"));
    assert_ne!(file_name("http://localhost:3000"), file_name("http://localhost:5173"));
}

/// Lo que la página tenía al cerrar la app vuelve al abrirla: las cookies —de sesión
/// incluidas, que son las de un login típico— y la copia del storage, una sola vez.
#[test]
fn el_sitio_sobrevive_a_reiniciar_la_app() {
    let dir = site_dir("reinicio");
    let origin = "http://localhost:5173";
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    {
        let site = Site::open(origin, Some(&dir));
        site.store_from_server(&["sid=abc; Path=/; HttpOnly".into(), "tema=oscuro; Max-Age=3600".into()], "/login", "http://localhost:5173/login", now);
        site.store_from_script("idioma=es", "/panel", "http://localhost:5173/panel", now);
        site.save_storage(StorageCopy {
            local: Some(vec![("token".into(), "xyz".into())]),
            session: Some(vec![("paso".into(), "2".into())]),
        });
        site.save_now().unwrap();
    }
    let file = dir.join(file_name(origin));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "tiene sesiones adentro: solo lo lee el usuario");
    }

    let reopened = Site::open(origin, Some(&dir));
    assert_eq!(reopened.cookie_header("/", now / 1000).as_deref(), Some("sid=abc; tema=oscuro; idioma=es"));
    assert_eq!(reopened.script_cookies("/", now / 1000).0, "tema=oscuro; idioma=es");
    let restore = reopened.take_restore();
    assert_eq!(restore.local, Some(vec![("token".into(), "xyz".into())]));
    assert_eq!(restore.session, Some(vec![("paso".into(), "2".into())]));
    assert_eq!(reopened.take_restore(), StorageCopy::default(), "se repone una sola vez");

    // Olvidar el sitio deja el archivo como el de uno nunca abierto.
    reopened.forget_all();
    reopened.save_now().unwrap();
    let forgotten = Site::open(origin, Some(&dir));
    assert!(forgotten.cookies(now / 1000).is_empty());
    assert_eq!(forgotten.take_restore(), StorageCopy::default());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Si la página ya mandó su storage, esa ejecución no repone nada: la copia vieja
/// resucitaría lo que la página borró (un logout seguido de una recarga).
#[test]
fn despues_de_guardar_ya_no_se_repone() {
    let dir = site_dir("sin-reponer");
    let origin = "http://localhost:3000";
    let first = Site::open(origin, Some(&dir));
    first.save_storage(StorageCopy { local: Some(vec![("token".into(), "1".into())]), session: None });
    first.save_now().unwrap();

    let second = Site::open(origin, Some(&dir));
    second.save_storage(StorageCopy { local: Some(vec![]), session: Some(vec![]) });
    assert_eq!(second.take_restore(), StorageCopy::default());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Un archivo roto no puede impedir que el navegador arranque.
#[test]
fn un_archivo_roto_se_ignora() {
    let dir = site_dir("roto");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(file_name("http://localhost:1")), b"{ no es json").unwrap();
    let site = Site::open("http://localhost:1", Some(&dir));
    assert!(site.cookies(0).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
