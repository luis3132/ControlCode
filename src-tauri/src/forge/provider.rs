//! Los tipos de host y lo que cambia entre uno y otro: dónde está su API y con qué usuario
//! se presenta git por HTTPS.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForgeKind {
    Github,
    Gitlab,
    /// Gitea y Forgejo (Codeberg incluido): comparten la API.
    Gitea,
    /// Cualquier otro host: solo credenciales para git, sin API (ni PRs ni issues).
    Other,
}

impl ForgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ForgeKind::Github => "github",
            ForgeKind::Gitlab => "gitlab",
            ForgeKind::Gitea => "gitea",
            ForgeKind::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "github" => ForgeKind::Github,
            "gitlab" => ForgeKind::Gitlab,
            "gitea" => ForgeKind::Gitea,
            "other" => ForgeKind::Other,
            _ => return None,
        })
    }

    pub fn default_host(self) -> Option<&'static str> {
        match self {
            ForgeKind::Github => Some("github.com"),
            ForgeKind::Gitlab => Some("gitlab.com"),
            ForgeKind::Gitea => Some("codeberg.org"),
            ForgeKind::Other => None,
        }
    }

    pub fn has_api(self) -> bool {
        self != ForgeKind::Other
    }

    /// La raíz de la API REST. GitHub.com la tiene en otro dominio; un GitHub Enterprise
    /// la sirve bajo `/api/v3` del propio host.
    pub fn api_base(self, host: &str) -> String {
        match self {
            ForgeKind::Github if host == "github.com" => "https://api.github.com".to_string(),
            ForgeKind::Github => format!("https://{host}/api/v3"),
            ForgeKind::Gitlab => format!("https://{host}/api/v4"),
            ForgeKind::Gitea => format!("https://{host}/api/v1"),
            ForgeKind::Other => String::new(),
        }
    }

    /// El usuario que git manda junto al token por HTTPS. GitHub y GitLab ignoran el
    /// usuario si el token vale, pero cada uno documenta uno fijo; Gitea quiere el login.
    pub fn git_user(self, login: &str, git_user: Option<&str>) -> String {
        match self {
            ForgeKind::Github => "x-access-token".to_string(),
            ForgeKind::Gitlab => "oauth2".to_string(),
            ForgeKind::Gitea => login.to_string(),
            ForgeKind::Other => git_user.filter(|u| !u.is_empty()).unwrap_or(login).to_string(),
        }
    }

    /// El tipo que más probablemente es un host que no tiene cuenta todavía.
    pub fn guess(host: &str) -> Option<Self> {
        use crate::scm::Provider;
        match crate::scm::provider_of(host) {
            Provider::Github => Some(ForgeKind::Github),
            Provider::Gitlab => Some(ForgeKind::Gitlab),
            Provider::Codeberg => Some(ForgeKind::Gitea),
            _ => None,
        }
    }
}

/// Normaliza lo que el usuario escribe como host: sin esquema, sin barra final, en
/// minúsculas. Acepta un puerto (`git.empresa.com:8443`) y nada de ruta.
pub fn normalize_host(input: &str) -> Result<String, String> {
    let mut host = input.trim().to_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = host.strip_prefix(scheme) {
            host = rest.to_string();
        }
    }
    let host = host.trim_end_matches('/').to_string();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        && !host.starts_with(['.', '-', ':']);
    if !valid {
        return Err(format!("«{input}» no es un host válido (ej. github.com o git.empresa.com)"));
    }
    Ok(host)
}

/// El host sin puerto, que es como lo trae un remoto por SSH.
pub fn bare_host(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

/// Un error que la UI sabe distinguir.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ForgeError {
    /// No hay cuenta para ese host: el mensaje es el host, para ofrecer iniciar sesión.
    NoAccount(String),
    /// El host rechazó el token (vencido o revocado): hay que volver a iniciar sesión.
    Auth(String),
    /// El host no tiene API (cuenta genérica) o el repo no tiene remoto.
    Unsupported(String),
    Api(String),
}

impl From<String> for ForgeError {
    fn from(e: String) -> Self {
        ForgeError::Api(e)
    }
}

impl From<&str> for ForgeError {
    fn from(e: &str) -> Self {
        ForgeError::Api(e.to_string())
    }
}

impl std::fmt::Display for ForgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForgeError::NoAccount(host) => write!(f, "No Control Code git account is signed in for {host}. Ask the user to add one in Accounts → Git."),
            ForgeError::Auth(m) | ForgeError::Unsupported(m) | ForgeError::Api(m) => f.write_str(m),
        }
    }
}
