//! Lo que el proxy cambia de las peticiones y respuestas, como funciones puras.

/// Dónde se sirve el selector. Una ruta y no un `<script>` en línea: una página con CSP
/// `script-src 'self'` bloquearía el inline, pero acepta un script de su propio origen.
pub(crate) const PICKER_PATH: &str = "/__controlcode__/picker.js";

const PICKER_TAG: &str = r#"<script src="/__controlcode__/picker.js"></script>"#;

/// Encabezados de un solo salto: describen la conexión con el proxy, no el contenido.
pub(crate) fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "proxy-authenticate"
            | "proxy-authorization" | "te" | "trailer" | "transfer-encoding" | "upgrade"
    )
}

/// Lo que no se le reenvía al servidor.
///
/// `accept-encoding` se saca para que conteste sin comprimir: el HTML hay que poder leerlo
/// para inyectarle el selector. En un servidor de desarrollo local no cuesta nada.
pub(crate) fn skip_request_header(name: &str) -> bool {
    is_hop_by_hop(name) || matches!(name.to_ascii_lowercase().as_str(), "host" | "accept-encoding" | "content-length")
}

/// Lo que no se le devuelve al iframe.
///
/// `x-frame-options` y la CSP prohíben mostrar la página adentro de otra, que es justo lo
/// que se quiere acá. Es la vista previa del proyecto del propio usuario, en su máquina.
pub(crate) fn skip_response_header(name: &str) -> bool {
    is_hop_by_hop(name)
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "x-frame-options" | "content-security-policy" | "content-security-policy-report-only"
        )
}

/// Agrega el `<script>` del selector lo más arriba posible: justo después de `<head>`, o de
/// `<html>`, o al principio si la página no trae ninguno de los dos.
pub(crate) fn inject_picker(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let after_tag = |tag: &str| -> Option<usize> {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(tag) {
            let start = from + pos;
            let next = lower.as_bytes().get(start + tag.len()).copied();
            // `<head` pero no `<header`.
            if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
                return lower[start..].find('>').map(|end| start + end + 1);
            }
            from = start + tag.len();
        }
        None
    };
    let at = after_tag("<head").or_else(|| after_tag("<html")).unwrap_or(0);
    let mut out = String::with_capacity(html.len() + PICKER_TAG.len());
    out.push_str(&html[..at]);
    out.push_str(PICKER_TAG);
    out.push_str(&html[at..]);
    out
}

/// Una redirección a una URL absoluta del servidor tiene que volver a pasar por el proxy;
/// si no, el iframe se iría directo al servidor y perdería el selector.
pub(crate) fn rewrite_location(value: &str, target_origin: &str, proxy_origin: &str) -> String {
    match value.strip_prefix(target_origin) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') => {
            format!("{proxy_origin}{rest}")
        }
        _ => value.to_string(),
    }
}

/// El iframe habla con el proxy (`localhost:<puerto>`), no con el host del servidor: una
/// cookie con `Domain=` de otro host se descartaría. Sin `Domain` queda atada al host que la
/// recibe.
pub(crate) fn strip_cookie_domain(cookie: &str) -> String {
    cookie
        .split(';')
        .filter(|part| !part.trim_start().to_ascii_lowercase().starts_with("domain="))
        .collect::<Vec<_>>()
        .join(";")
}

/// Un servidor que valida `Origin`/`Referer` (Vite con sus WebSocket, frameworks con CSRF)
/// tiene que ver el suyo, no el del proxy.
pub(crate) fn rewrite_origin_value(value: &str, proxy_origin: &str, target_origin: &str) -> String {
    match value.strip_prefix(proxy_origin) {
        Some(rest) => format!("{target_origin}{rest}"),
        None => value.to_string(),
    }
}

pub(crate) fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "::1"
        || host == "0.0.0.0"
        || host.starts_with("127.")
}

/// Status y encabezados de la cabecera cruda de una respuesta HTTP/1.1.
pub(crate) fn parse_response_head(head: &str) -> Option<(u16, Vec<(String, String)>)> {
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Some((status, headers))
}
