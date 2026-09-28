//! Los pedidos de la página a OTROS orígenes (una API en otro puerto, un servicio externo),
//! y las reglas de CORS con que se los deja pasar.
//!
//! ## El problema
//!
//! La página no corre en su origen sino en el del proxy (`http://localhost:<puerto>`, ver
//! `proxy.rs`). Para todo lo que no es su propio servidor eso rompía tres cosas a la vez:
//!
//! - **CORS.** Una API que acepta `http://localhost:5173` recibía `Origin:
//!   http://localhost:47567` y no devolvía los encabezados: `TypeError: Failed to fetch`.
//! - **Cookies.** El proxy solo guardaba las del sitio principal; las de la API las
//!   manejaba el motor del webview, que a un iframe de otro origen le bloquea o le pierde.
//! - **URLs absolutas.** Un `fetch("http://localhost:5173/data.json")` al propio servidor
//!   era, desde el origen del proxy, otro origen más.
//!
//! ## La solución
//!
//! El runtime de la página manda esos pedidos al proxy (`FWD_PATH?url=…`), que pasa a ser la
//! capa de red de la página también para ellos: los reenvía con el `Origin` REAL de la
//! página, guarda las cookies de cada origen en su frasco (`site.rs`), y aplica él mismo
//! las reglas de CORS contra ese origen real — preflight incluido.
//!
//! Aplicarlas acá no es opcional. Sin eso, cualquier sitio abierto en el navegador de la app
//! podría leer, con las cookies guardadas, lo que conteste una API local que nunca lo
//! autorizó. Con esto, la página puede exactamente lo que podría en un navegador normal
//! corriendo en su origen: ni más, ni menos.

/// Donde el runtime manda los pedidos a otros orígenes: `FWD_PATH?url=<url absoluta>`.
pub(crate) const FWD_PATH: &str = "/__controlcode__/fwd";

/// El modo de credenciales del pedido (`omit`, `same-origin`, `include`), que el proxy no
/// puede deducir: es una opción del `fetch` (o el `withCredentials` de un XHR).
pub(crate) const CRED_HEADER: &str = "x-controlcode-cred";

/// Las cabeceras que puso la página, por nombre y separadas por coma. Lo demás que llegue
/// lo agregó el motor del webview por su cuenta: `Cache-Control: no-cache` y `Pragma:
/// no-cache` con la caché desactivada, por ejemplo. Un navegador las pone en la capa de
/// red, después del chequeo de CORS, así que no piden preflight; contándolas como de la
/// página, el proxy pedía uno que el servidor rechazaba con toda razón.
pub(crate) const HEADERS_HEADER: &str = "x-controlcode-headers";

/// Los nombres que trae `HEADERS_HEADER`, en minúsculas. `Content-Type` siempre cuenta
/// como de la página: si no la puso ella, sale del cuerpo que mandó, y para CORS es igual.
pub(crate) fn authored_headers(value: &str) -> std::collections::HashSet<String> {
    value
        .split(',')
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty())
        .chain(std::iter::once("content-type".to_string()))
        .collect()
}

/// En la respuesta a un pedido que CORS no dejó pasar: el motivo, para la consola.
pub(crate) const CORS_HEADER: &str = "x-controlcode-cors";

/// Cómo pide la página que viajen las cookies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Credentials {
    Omit,
    SameOrigin,
    Include,
}

impl Credentials {
    /// El valor de `fetch`: `same-origin` es el de siempre.
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("include") => Credentials::Include,
            Some("omit") => Credentials::Omit,
            _ => Credentials::SameOrigin,
        }
    }

    /// Si van (y se guardan) cookies. A otro origen solo con `include`; al propio, salvo `omit`.
    pub(crate) fn sends_cookies(self, same_origin: bool) -> bool {
        match self {
            Credentials::Omit => false,
            Credentials::SameOrigin => same_origin,
            Credentials::Include => true,
        }
    }
}

fn is_local(host: &str) -> bool {
    super::rewrite::is_local_host(host)
}

/// El "sitio" de un host, para las cookies `SameSite`: todos los nombres del loopback son el
/// mismo (un front en `localhost:5173` y su API en `127.0.0.1:8080` son el mismo sitio en la
/// práctica), y para el resto, los dos últimos rótulos (`api.ejemplo.com` → `ejemplo.com`).
/// No conoce la lista de sufijos públicos: `a.github.io` y `b.github.io` quedan como el mismo
/// sitio, lo que como mucho manda de más una cookie `SameSite=Lax` entre dos de esos.
fn site_of(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if is_local(&host) {
        return "localhost".to_string();
    }
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return host;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels[labels.len().saturating_sub(2)..].join(".")
}

/// Si un pedido de una página en `page_host` a `host` es del mismo sitio: ahí viajan las
/// cookies `SameSite=Lax` y `Strict`; entre sitios distintos, solo las `SameSite=None`.
pub(crate) fn same_site(page_host: &str, host: &str) -> bool {
    site_of(page_host) == site_of(host)
}

const SIMPLE_METHODS: &[&str] = &["GET", "HEAD", "POST"];
const SIMPLE_CONTENT_TYPES: &[&str] = &["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

/// Un encabezado que un pedido puede llevar sin preflight (la lista "CORS-safelisted").
pub(crate) fn is_safelisted_header(name: &str, value: &str) -> bool {
    match name.to_ascii_lowercase().as_str() {
        "accept" | "accept-language" | "content-language" => value.len() <= 128,
        "content-type" => {
            let essence = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            SIMPLE_CONTENT_TYPES.contains(&essence.as_str())
        }
        _ => false,
    }
}

/// Los encabezados que el preflight tiene que pedir permiso para mandar: en minúsculas,
/// ordenados y sin repetir, como los pone un navegador en `Access-Control-Request-Headers`.
pub(crate) fn unsafe_headers(headers: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = headers
        .iter()
        .filter(|(n, v)| !is_safelisted_header(n, v))
        .map(|(n, _)| n.to_ascii_lowercase())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Si el pedido necesita preflight: un método que no es GET/HEAD/POST, o algún encabezado
/// fuera de la lista (un `Content-Type: application/json`, un `Authorization`).
pub(crate) fn needs_preflight(method: &str, headers: &[(String, String)]) -> bool {
    !SIMPLE_METHODS.contains(&method.to_ascii_uppercase().as_str()) || !unsafe_headers(headers).is_empty()
}

/// Si la respuesta deja que la página (en `page_origin`) la lea.
pub(crate) fn check_response(
    page_origin: &str,
    credentials: bool,
    allow_origin: Option<&str>,
    allow_credentials: Option<&str>,
) -> Result<(), String> {
    let Some(allowed) = allow_origin.map(str::trim) else {
        return Err(format!(
            "la respuesta no tiene Access-Control-Allow-Origin: el servidor no autoriza a {page_origin}"
        ));
    };
    if allowed == "*" {
        if credentials {
            return Err("Access-Control-Allow-Origin es '*', que no vale para un pedido con credenciales".into());
        }
        return Ok(());
    }
    if allowed != page_origin {
        return Err(format!("Access-Control-Allow-Origin es '{allowed}', y la página es {page_origin}"));
    }
    if credentials && allow_credentials.map(str::trim) != Some("true") {
        return Err("el pedido lleva credenciales y la respuesta no tiene Access-Control-Allow-Credentials: true".into());
    }
    Ok(())
}

fn list_contains(list: Option<&str>, item: &str) -> bool {
    list.unwrap_or("").split(',').any(|v| v.trim().eq_ignore_ascii_case(item))
}

/// Lo que contestó el preflight.
pub(crate) struct Preflight<'a> {
    pub status: u16,
    pub allow_origin: Option<&'a str>,
    pub allow_credentials: Option<&'a str>,
    pub allow_methods: Option<&'a str>,
    pub allow_headers: Option<&'a str>,
}

/// Si el preflight autoriza el pedido: el origen, el método y cada encabezado.
pub(crate) fn check_preflight(
    page_origin: &str,
    credentials: bool,
    method: &str,
    request_headers: &[String],
    answer: &Preflight<'_>,
) -> Result<(), String> {
    if !(200..300).contains(&answer.status) {
        return Err(format!("el preflight (OPTIONS) contestó {}", answer.status));
    }
    check_response(page_origin, credentials, answer.allow_origin, answer.allow_credentials)?;
    let wildcard = |list: Option<&str>| !credentials && list_contains(list, "*");
    let method = method.to_ascii_uppercase();
    if !SIMPLE_METHODS.contains(&method.as_str()) && !list_contains(answer.allow_methods, &method) && !wildcard(answer.allow_methods) {
        return Err(format!("el preflight no permite el método {method} (Access-Control-Allow-Methods)"));
    }
    for header in request_headers {
        // `Authorization` nunca queda cubierto por el comodín.
        let by_wildcard = wildcard(answer.allow_headers) && header != "authorization";
        if !list_contains(answer.allow_headers, header) && !by_wildcard {
            return Err(format!("el preflight no permite el encabezado '{header}' (Access-Control-Allow-Headers)"));
        }
    }
    Ok(())
}

/// `url` en la forma en que se la pide al proxy.
pub(crate) fn fwd_url(proxy_origin: &str, url: &str) -> String {
    let mut encoder = reqwest::Url::parse("http://x/").expect("URL fija válida");
    encoder.query_pairs_mut().append_pair("url", url);
    format!("{proxy_origin}{FWD_PATH}?{}", encoder.query().unwrap_or(""))
}

/// Una redirección de un pedido reenviado, para que el `fetch` la siga pasando por el proxy:
/// al servidor de la página, directo por su ruta; a cualquier otro, de nuevo por `FWD_PATH`.
pub(crate) fn fwd_location(location: &str, request_url: &str, page_origin: &str, proxy_origin: &str) -> String {
    let Some(resolved) = reqwest::Url::parse(request_url).ok().and_then(|base| base.join(location).ok()) else {
        return location.to_string();
    };
    if !matches!(resolved.scheme(), "http" | "https") {
        return location.to_string();
    }
    if resolved.origin().ascii_serialization() == page_origin {
        let mut rest = resolved.path().to_string();
        if let Some(q) = resolved.query() {
            rest.push('?');
            rest.push_str(q);
        }
        return format!("{proxy_origin}{rest}");
    }
    fwd_url(proxy_origin, resolved.as_str())
}
