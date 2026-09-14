use super::rewrite::{
    inject_picker, is_local_host, parse_response_head, rewrite_location, rewrite_origin_value,
    skip_request_header, skip_response_header, strip_cookie_domain,
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

#[test]
fn a_las_cookies_se_les_saca_solo_el_dominio() {
    assert_eq!(
        strip_cookie_domain("sid=abc; Path=/; Domain=localhost; HttpOnly; SameSite=Lax"),
        "sid=abc; Path=/; HttpOnly; SameSite=Lax"
    );
    assert_eq!(strip_cookie_domain("theme=dark"), "theme=dark");
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

                let (status, extra, body) = match path.as_str() {
                    "/" => ("200 OK", "Content-Type: text/html; charset=utf-8\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\n",
                            "<html><head><title>Hola</title></head><body>hola</body></html>".to_string()),
                    "/app.js" => ("200 OK", "Content-Type: application/javascript\r\n", "console.log(1)".to_string()),
                    "/login" => ("302 Found", &*Box::leak(format!("Location: http://127.0.0.1:{port}/panel\r\n").into_boxed_str()), String::new()),
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
