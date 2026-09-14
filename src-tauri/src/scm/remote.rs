//! De qué servicio es un remoto. Es lo que decide qué ícono se muestra, a dónde lleva
//! "abrir en la web" y —cuando exista— con qué proveedor iniciar sesión.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Github,
    Gitlab,
    Bitbucket,
    Azure,
    Codeberg,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
    pub provider: Provider,
    pub host: Option<String>,
    /// La página del repo, cuando se puede deducir con certeza.
    pub web_url: Option<String>,
}

/// Separa host y ruta de cualquiera de las formas en que git escribe un remoto:
/// `https://host/ruta`, `ssh://user@host:22/ruta` y la de scp, `user@host:ruta`.
pub(crate) fn host_and_path(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit('@').next()?;
        // Un puerto (`host:22`) no es parte del nombre. IPv6 entre corchetes queda entero.
        let host = if host.starts_with('[') {
            host.to_string()
        } else {
            host.split(':').next()?.to_string()
        };
        return Some((host.to_lowercase(), path.to_string()));
    }
    // Forma scp: `git@github.com:owner/repo.git`. Una ruta local (`/srv/repo.git`,
    // `C:\repo`) no tiene `@host:` antes de la primera barra.
    let (before, path) = url.split_once(':')?;
    if before.contains('/') || before.contains('\\') || before.len() == 1 {
        return None;
    }
    let host = before.rsplit('@').next()?;
    Some((host.to_lowercase(), path.to_string()))
}

pub(crate) fn provider_of(host: &str) -> Provider {
    match host {
        "github.com" | "ssh.github.com" => Provider::Github,
        "gitlab.com" => Provider::Gitlab,
        "bitbucket.org" => Provider::Bitbucket,
        "dev.azure.com" | "ssh.dev.azure.com" => Provider::Azure,
        h if h.ends_with(".visualstudio.com") => Provider::Azure,
        "codeberg.org" => Provider::Codeberg,
        // Un GitLab propio casi siempre lleva el nombre en el host. Un GitHub Enterprise
        // no tiene nada que lo delate, así que queda como genérico.
        h if h.starts_with("gitlab.") || h.contains(".gitlab.") => Provider::Gitlab,
        _ => Provider::Other,
    }
}

pub(crate) fn remote_from(name: &str, url: &str) -> Remote {
    let parsed = host_and_path(url);
    let provider = parsed.as_ref().map(|(h, _)| provider_of(h)).unwrap_or(Provider::Other);
    let web_url = parsed.as_ref().and_then(|(host, path)| {
        let path = path.trim_start_matches('/').trim_end_matches('/').trim_end_matches(".git");
        match provider {
            Provider::Github | Provider::Gitlab | Provider::Bitbucket | Provider::Codeberg
                if !path.is_empty() =>
            {
                // Por SSH el host puede ser el alias de ssh (`ssh.github.com`); la web es
                // siempre el dominio principal.
                let web_host = host.strip_prefix("ssh.").unwrap_or(host);
                Some(format!("https://{web_host}/{path}"))
            }
            _ => None,
        }
    });
    Remote {
        name: name.to_string(),
        url: url.to_string(),
        provider,
        host: parsed.map(|(h, _)| h),
        web_url,
    }
}

/// `git remote -v` trae cada remoto dos veces (fetch y push); se toma el de fetch.
pub(crate) fn parse_remotes(raw: &str) -> Vec<Remote> {
    raw.lines()
        .filter(|l| l.ends_with("(fetch)"))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some(remote_from(parts.next()?, parts.next()?))
        })
        .collect()
}
