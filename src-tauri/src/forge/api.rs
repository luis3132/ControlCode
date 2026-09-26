//! Las APIs REST de GitHub, GitLab y Gitea/Forgejo, llevadas a unas mismas formas.
//!
//! Cada host nombra distinto lo mismo (un PR es un "merge request" en GitLab, el número es
//! `iid`, "abierto" es `opened`). La UI y el MCP ven una sola forma; las diferencias viven
//! acá y en ningún otro lado.
//!
//! Se lee cada respuesta como `Value` y se mapea campo por campo en vez de declarar un
//! struct por host y por recurso: son tres APIs que cambian con los años, y un campo que
//! falta tiene que dar un valor vacío, no un error de deserialización que tire toda la
//! lista.

use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::provider::{ForgeError, ForgeKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepo {
    /// `owner/repo` (en GitLab puede tener subgrupos: `grupo/sub/repo`).
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub clone_url: String,
    pub ssh_url: Option<String>,
    pub web_url: String,
    pub default_branch: Option<String>,
    pub updated_at: Option<String>,
}

/// Un PR (merge request en GitLab) o un issue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub number: u64,
    pub title: String,
    /// `open`, `closed` o `merged`.
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub web_url: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub comments: Option<u64>,
    pub labels: Vec<String>,
    /// Solo PRs: de qué rama a qué rama.
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub author: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    #[serde(flatten)]
    pub item: Item,
    pub body: Option<String>,
    pub thread: Vec<Comment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPull {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    pub head: String,
    pub base: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewIssue {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
}

/// Un chequeo de CI sobre un commit: un job de GitHub Actions, un status de un servicio
/// externo, un job de un pipeline de GitLab.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// `success`, `failure`, `pending`, `running`, `skipped`, `cancelled` o `neutral`.
    pub state: String,
    pub url: Option<String>,
}

/// El resultado de todos los chequeos juntos: falla si alguno falló, pendiente si alguno
/// sigue, y bien solo si todos terminaron sin fallar. Sin chequeos no hay veredicto.
pub fn overall(checks: &[Check]) -> &'static str {
    if checks.is_empty() {
        "none"
    } else if checks.iter().any(|c| c.state == "failure") {
        "failure"
    } else if checks.iter().any(|c| c.state == "pending" || c.state == "running") {
        "pending"
    } else if checks.iter().any(|c| c.state == "cancelled") {
        "cancelled"
    } else {
        "success"
    }
}

/// Un archivo que toca un PR.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub old_path: Option<String>,
    /// `added`, `removed`, `modified` o `renamed`.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// El diff unificado de ese archivo, cuando el host lo da.
    pub patch: Option<String>,
}

/// Cuenta líneas agregadas y quitadas de un diff unificado (GitLab no las da sueltas).
pub(super) fn count_patch(patch: &str) -> (u64, u64) {
    patch.lines().fold((0, 0), |(a, d), l| {
        if l.starts_with('+') && !l.starts_with("+++") {
            (a + 1, d)
        } else if l.starts_with('-') && !l.starts_with("---") {
            (a, d + 1)
        } else {
            (a, d)
        }
    })
}

/// GitHub: los check runs (Actions y apps) más los statuses (servicios que usan la API
/// vieja). Un mismo commit puede tener de los dos.
pub(super) fn github_checks(runs: &Value, combined: &Value) -> Vec<Check> {
    let mut out: Vec<Check> = runs
        .get("check_runs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    let state = match (s(r, "/status").as_deref(), s(r, "/conclusion").as_deref()) {
                        (Some("completed"), Some("success")) => "success",
                        (Some("completed"), Some("failure" | "timed_out" | "action_required" | "startup_failure")) => "failure",
                        (Some("completed"), Some("cancelled")) => "cancelled",
                        (Some("completed"), Some("skipped")) => "skipped",
                        (Some("completed"), _) => "neutral",
                        (Some("in_progress"), _) => "running",
                        _ => "pending",
                    };
                    Check {
                        name: s(r, "/name").unwrap_or_default(),
                        state: state.into(),
                        url: s(r, "/html_url").or_else(|| s(r, "/details_url")),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(statuses) = combined.get("statuses").and_then(Value::as_array) {
        out.extend(statuses.iter().map(|st| Check {
            name: s(st, "/context").unwrap_or_default(),
            state: match s(st, "/state").as_deref() {
                Some("success") => "success",
                Some("failure" | "error") => "failure",
                _ => "pending",
            }
            .into(),
            url: s(st, "/target_url").filter(|u| !u.is_empty()),
        }));
    }
    out
}

/// GitLab: los jobs del último pipeline del commit.
pub(super) fn gitlab_checks(jobs: &[Value]) -> Vec<Check> {
    jobs.iter()
        .map(|j| Check {
            name: s(j, "/name").unwrap_or_default(),
            state: match s(j, "/status").as_deref() {
                Some("success") => "success",
                Some("failed") => "failure",
                Some("running") => "running",
                Some("canceled") => "cancelled",
                Some("skipped" | "manual") => "skipped",
                _ => "pending",
            }
            .into(),
            url: s(j, "/web_url"),
        })
        .collect()
}

/// Gitea/Forgejo: los statuses combinados del commit (Actions los publica ahí).
pub(super) fn gitea_checks(combined: &Value) -> Vec<Check> {
    combined
        .get("statuses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|st| Check {
                    name: s(st, "/context").unwrap_or_default(),
                    state: match s(st, "/status").as_deref() {
                        Some("success") => "success",
                        Some("failure" | "error") => "failure",
                        Some("warning") => "neutral",
                        _ => "pending",
                    }
                    .into(),
                    url: s(st, "/target_url").filter(|u| !u.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Separa un diff de varios archivos (`git diff`) en uno por archivo, por su ruta nueva.
pub(super) fn split_diff(raw: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for chunk in raw.split("\ndiff --git ").enumerate().map(|(i, c)| if i == 0 { c.trim_start_matches("diff --git ").to_string() } else { c.to_string() }) {
        let Some(header) = chunk.lines().next() else { continue };
        // `a/ruta b/ruta`: la nueva es la de `b/`.
        let Some(path) = header.rsplit_once(" b/").map(|(_, p)| p.to_string()) else { continue };
        let body = chunk.split_once("\n@@").map(|(_, rest)| format!("@@{rest}")).unwrap_or_default();
        out.push((path, body));
    }
    out
}

/// Una etiqueta del repo, para ofrecerla al abrir un issue.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// Hex sin `#` (`d73a4a`). Cada host lo da con o sin él.
    pub color: Option<String>,
    pub description: Option<String>,
}

/// Una release publicada (o en borrador) en el host.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    pub name: String,
    pub body: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub web_url: String,
    pub created_at: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRelease {
    pub tag: String,
    /// Dónde crear el tag si todavía no existe en el host: una rama o un commit.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

/// Qué lista se pide: `open`, `closed`, `merged` (solo PRs) o `all`.
pub fn normalize_state(state: Option<&str>) -> &'static str {
    match state.unwrap_or("open") {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "open",
    }
}

pub struct Api {
    kind: ForgeKind,
    base: String,
    token: String,
    http: reqwest::Client,
}

fn s(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer).and_then(Value::as_str).map(str::to_string)
}

fn b(v: &Value, pointer: &str) -> bool {
    v.pointer(pointer).and_then(Value::as_bool).unwrap_or(false)
}

fn n(v: &Value, pointer: &str) -> Option<u64> {
    v.pointer(pointer).and_then(Value::as_u64)
}

/// Las etiquetas: GitHub y Gitea las dan como objetos con `name`, GitLab como strings.
fn labels(v: &Value) -> Vec<String> {
    v.get("labels")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.as_str().map(str::to_string).or_else(|| s(l, "/name")))
                .collect()
        })
        .unwrap_or_default()
}

/// El id de proyecto de GitLab: la ruta completa, con las barras escapadas.
pub(super) fn label_from(v: &Value) -> Option<Label> {
    Some(Label {
        name: s(v, "/name").filter(|n| !n.is_empty())?,
        color: s(v, "/color").map(|c| c.trim_start_matches('#').to_string()).filter(|c| !c.is_empty()),
        description: s(v, "/description").filter(|d| !d.is_empty()),
    })
}

fn gl_project(repo: &str) -> String {
    repo.replace('/', "%2F")
}

impl Api {
    pub fn new(kind: ForgeKind, host: &str, token: &str) -> Result<Self, ForgeError> {
        if !kind.has_api() {
            return Err(ForgeError::Unsupported(format!(
                "{host} is a generic git account: it can push and pull, but there is no API for pull requests or issues."
            )));
        }
        let http = reqwest::Client::builder()
            .user_agent("ControlCode")
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| ForgeError::Api(e.to_string()))?;
        Ok(Api { kind, base: kind.api_base(host), token: token.to_string(), http })
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, ForgeError> {
        let url = format!("{}{}", self.base, path);
        let mut req = self.http.request(method, &url);
        req = match self.kind {
            ForgeKind::Gitea => req.header("Authorization", format!("token {}", self.token)),
            _ => req.bearer_auth(&self.token),
        };
        if self.kind == ForgeKind::Github {
            req = req.header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|e| ForgeError::Api(format!("No se pudo contactar a la API: {e}")))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let value: Value = if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        if status.is_success() {
            return Ok(value);
        }
        let message = s(&value, "/message")
            .or_else(|| s(&value, "/error_description"))
            .or_else(|| s(&value, "/error"))
            .or_else(|| value.get("message").map(|m| m.to_string()))
            .unwrap_or_else(|| value.to_string());
        // GitHub explica el motivo de un 422 en `errors`: sin eso "Validation Failed" no
        // dice nada (p. ej. "ya existe un PR para esta rama").
        let details = value
            .get("errors")
            .and_then(Value::as_array)
            .map(|errs| {
                errs.iter()
                    .filter_map(|e| s(e, "/message").or_else(|| e.as_str().map(str::to_string)))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|d| !d.is_empty());
        let message = match details {
            Some(d) => format!("{message}: {d}"),
            None => message,
        };
        Err(match status.as_u16() {
            401 => ForgeError::Auth(format!("The host rejected the token ({message}). Sign in again.")),
            404 => ForgeError::Api(format!("Not found, or the account has no access ({message})")),
            code => ForgeError::Api(format!("HTTP {code}: {message}")),
        })
    }

    async fn get(&self, path: &str) -> Result<Value, ForgeError> {
        self.call(Method::GET, path, None).await
    }

    async fn get_list(&self, path: &str) -> Result<Vec<Value>, ForgeError> {
        Ok(self.get(path).await?.as_array().cloned().unwrap_or_default())
    }

    pub async fn me(&self) -> Result<ForgeUser, ForgeError> {
        let v = self.get("/user").await?;
        let login = match self.kind {
            ForgeKind::Gitlab => s(&v, "/username"),
            _ => s(&v, "/login"),
        }
        .ok_or_else(|| ForgeError::Api("La API no devolvió el usuario".to_string()))?;
        let name = match self.kind {
            ForgeKind::Gitea => s(&v, "/full_name"),
            _ => s(&v, "/name"),
        }
        .filter(|n| !n.is_empty());
        Ok(ForgeUser { login, name, avatar_url: s(&v, "/avatar_url") })
    }

    /// Los repos a los que la cuenta tiene acceso, los más recientes primero. Hasta 1000:
    /// más que eso no se recorre a ojo, y cada página es un pedido.
    pub async fn repos(&self) -> Result<Vec<ForgeRepo>, ForgeError> {
        let mut all = Vec::new();
        for page in 1..=10 {
            let (path, per_page) = match self.kind {
                ForgeKind::Github => (
                    format!("/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member"),
                    100,
                ),
                ForgeKind::Gitlab => (
                    format!("/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100&page={page}"),
                    100,
                ),
                _ => (format!("/user/repos?limit=50&page={page}"), 50),
            };
            let items = self.get_list(&path).await?;
            let count = items.len();
            all.extend(items.iter().map(|v| self.repo_from(v)));
            if count < per_page {
                break;
            }
        }
        Ok(all)
    }

    pub(super) fn repo_from(&self, v: &Value) -> ForgeRepo {
        match self.kind {
            ForgeKind::Gitlab => ForgeRepo {
                full_name: s(v, "/path_with_namespace").unwrap_or_default(),
                description: s(v, "/description").filter(|d| !d.is_empty()),
                private: s(v, "/visibility").map(|vis| vis != "public").unwrap_or(false),
                fork: v.get("forked_from_project").is_some_and(|f| !f.is_null()),
                archived: b(v, "/archived"),
                clone_url: s(v, "/http_url_to_repo").unwrap_or_default(),
                ssh_url: s(v, "/ssh_url_to_repo"),
                web_url: s(v, "/web_url").unwrap_or_default(),
                default_branch: s(v, "/default_branch"),
                updated_at: s(v, "/last_activity_at"),
            },
            _ => ForgeRepo {
                full_name: s(v, "/full_name").unwrap_or_default(),
                description: s(v, "/description").filter(|d| !d.is_empty()),
                private: b(v, "/private"),
                fork: b(v, "/fork"),
                archived: b(v, "/archived"),
                clone_url: s(v, "/clone_url").unwrap_or_default(),
                ssh_url: s(v, "/ssh_url"),
                web_url: s(v, "/html_url").unwrap_or_default(),
                default_branch: s(v, "/default_branch"),
                updated_at: s(v, "/pushed_at").or_else(|| s(v, "/updated_at")),
            },
        }
    }

    pub(super) fn item_from(&self, v: &Value, pr: bool) -> Item {
        match self.kind {
            ForgeKind::Gitlab => {
                let state = match s(v, "/state").as_deref() {
                    Some("merged") => "merged",
                    Some("closed") => "closed",
                    _ => "open",
                };
                Item {
                    number: n(v, "/iid").unwrap_or(0),
                    title: s(v, "/title").unwrap_or_default(),
                    state: state.to_string(),
                    draft: b(v, "/draft") || b(v, "/work_in_progress"),
                    author: s(v, "/author/username"),
                    web_url: s(v, "/web_url").unwrap_or_default(),
                    created_at: s(v, "/created_at"),
                    updated_at: s(v, "/updated_at"),
                    comments: n(v, "/user_notes_count"),
                    labels: labels(v),
                    source_branch: if pr { s(v, "/source_branch") } else { None },
                    target_branch: if pr { s(v, "/target_branch") } else { None },
                }
            }
            _ => {
                let merged = b(v, "/merged") || v.get("merged_at").is_some_and(|m| !m.is_null());
                let state = if merged {
                    "merged"
                } else if s(v, "/state").as_deref() == Some("closed") {
                    "closed"
                } else {
                    "open"
                };
                Item {
                    number: n(v, "/number").unwrap_or(0),
                    title: s(v, "/title").unwrap_or_default(),
                    state: state.to_string(),
                    draft: b(v, "/draft"),
                    author: s(v, "/user/login"),
                    web_url: s(v, "/html_url").unwrap_or_default(),
                    created_at: s(v, "/created_at"),
                    updated_at: s(v, "/updated_at"),
                    comments: n(v, "/comments"),
                    labels: labels(v),
                    source_branch: if pr { s(v, "/head/ref") } else { None },
                    target_branch: if pr { s(v, "/base/ref") } else { None },
                }
            }
        }
    }

    pub async fn pulls(&self, repo: &str, state: &str) -> Result<Vec<Item>, ForgeError> {
        let items = match self.kind {
            ForgeKind::Gitlab => {
                let st = match state { "open" => "opened", other => other };
                self.get_list(&format!(
                    "/projects/{}/merge_requests?state={st}&per_page=50&order_by=updated_at",
                    gl_project(repo)
                ))
                .await?
            }
            ForgeKind::Github => {
                let st = match state { "merged" => "closed", other => other };
                self.get_list(&format!("/repos/{repo}/pulls?state={st}&per_page=50&sort=updated&direction=desc")).await?
            }
            _ => {
                let st = match state { "merged" => "closed", other => other };
                self.get_list(&format!("/repos/{repo}/pulls?state={st}&limit=50&sort=recentupdate")).await?
            }
        };
        let mut out: Vec<Item> = items.iter().map(|v| self.item_from(v, true)).collect();
        // GitHub y Gitea no filtran "fusionados": se pide "cerrados" y se separa acá.
        match state {
            "merged" => out.retain(|i| i.state == "merged"),
            "closed" if self.kind != ForgeKind::Gitlab => out.retain(|i| i.state == "closed"),
            _ => {}
        }
        Ok(out)
    }

    pub async fn issues(&self, repo: &str, state: &str) -> Result<Vec<Item>, ForgeError> {
        let state = if state == "merged" { "closed" } else { state };
        let items = match self.kind {
            ForgeKind::Gitlab => {
                let st = match state { "open" => "opened", other => other };
                self.get_list(&format!(
                    "/projects/{}/issues?state={st}&per_page=50&order_by=updated_at",
                    gl_project(repo)
                ))
                .await?
            }
            ForgeKind::Github => {
                self.get_list(&format!("/repos/{repo}/issues?state={state}&per_page=50&sort=updated&direction=desc")).await?
            }
            _ => self.get_list(&format!("/repos/{repo}/issues?state={state}&type=issues&limit=50")).await?,
        };
        Ok(items
            .iter()
            // En GitHub los PRs también son issues: se reconocen por `pull_request`.
            .filter(|v| v.get("pull_request").is_none_or(Value::is_null))
            .map(|v| self.item_from(v, false))
            .collect())
    }

    pub async fn item(&self, repo: &str, number: u64, pr: bool) -> Result<ItemDetail, ForgeError> {
        let (path, notes_path) = match self.kind {
            ForgeKind::Gitlab => {
                let kind = if pr { "merge_requests" } else { "issues" };
                let base = format!("/projects/{}/{kind}/{number}", gl_project(repo));
                let notes = format!("{base}/notes?sort=asc&per_page=100");
                (base, notes)
            }
            _ => {
                let kind = if pr { "pulls" } else { "issues" };
                let limit = if self.kind == ForgeKind::Github { "per_page=100" } else { "limit=50" };
                (format!("/repos/{repo}/{kind}/{number}"), format!("/repos/{repo}/issues/{number}/comments?{limit}"))
            }
        };
        let v = self.get(&path).await?;
        let notes = self.get_list(&notes_path).await?;
        let thread = notes
            .iter()
            // GitLab mezcla en las notas las del sistema ("cambió la etiqueta").
            .filter(|c| !b(c, "/system"))
            .map(|c| Comment {
                author: s(c, "/author/username").or_else(|| s(c, "/user/login")),
                body: s(c, "/body").unwrap_or_default(),
                created_at: s(c, "/created_at"),
            })
            .collect();
        let body = match self.kind {
            ForgeKind::Gitlab => s(&v, "/description"),
            _ => s(&v, "/body"),
        }
        .filter(|b| !b.is_empty());
        Ok(ItemDetail { item: self.item_from(&v, pr), body, thread })
    }

    pub async fn create_pull(&self, repo: &str, new: &NewPull) -> Result<Item, ForgeError> {
        let v = match self.kind {
            ForgeKind::Gitlab => {
                // GitLab no tiene un campo de borrador al crear: es el prefijo del título.
                let title = if new.draft { format!("Draft: {}", new.title) } else { new.title.clone() };
                self.call(
                    Method::POST,
                    &format!("/projects/{}/merge_requests", gl_project(repo)),
                    Some(json!({
                        "source_branch": new.head, "target_branch": new.base,
                        "title": title, "description": new.body.clone().unwrap_or_default(),
                    })),
                )
                .await?
            }
            ForgeKind::Github => {
                self.call(
                    Method::POST,
                    &format!("/repos/{repo}/pulls"),
                    Some(json!({
                        "title": new.title, "head": new.head, "base": new.base,
                        "body": new.body.clone().unwrap_or_default(), "draft": new.draft,
                    })),
                )
                .await?
            }
            _ => {
                let title = if new.draft { format!("WIP: {}", new.title) } else { new.title.clone() };
                self.call(
                    Method::POST,
                    &format!("/repos/{repo}/pulls"),
                    Some(json!({
                        "title": title, "head": new.head, "base": new.base,
                        "body": new.body.clone().unwrap_or_default(),
                    })),
                )
                .await?
            }
        };
        Ok(self.item_from(&v, true))
    }

    pub async fn create_issue(&self, repo: &str, new: &NewIssue) -> Result<Item, ForgeError> {
        let body = new.body.clone().unwrap_or_default();
        let v = match self.kind {
            ForgeKind::Gitlab => {
                self.call(
                    Method::POST,
                    &format!("/projects/{}/issues", gl_project(repo)),
                    Some(json!({ "title": new.title, "description": body, "labels": new.labels.join(",") })),
                )
                .await?
            }
            ForgeKind::Github => {
                self.call(
                    Method::POST,
                    &format!("/repos/{repo}/issues"),
                    Some(json!({ "title": new.title, "body": body, "labels": new.labels })),
                )
                .await?
            }
            // Gitea pide las etiquetas por id, no por nombre: se crean sin ellas.
            _ => {
                self.call(Method::POST, &format!("/repos/{repo}/issues"), Some(json!({ "title": new.title, "body": body })))
                    .await?
            }
        };
        Ok(self.item_from(&v, false))
    }

    pub async fn comment(&self, repo: &str, number: u64, pr: bool, body: &str) -> Result<(), ForgeError> {
        let path = match self.kind {
            ForgeKind::Gitlab => {
                let kind = if pr { "merge_requests" } else { "issues" };
                format!("/projects/{}/{kind}/{number}/notes", gl_project(repo))
            }
            // En GitHub y Gitea los comentarios de un PR van por su issue.
            _ => format!("/repos/{repo}/issues/{number}/comments"),
        };
        self.call(Method::POST, &path, Some(json!({ "body": body }))).await.map(|_| ())
    }

    /// `method`: `merge`, `squash` o `rebase`.
    pub async fn merge(&self, repo: &str, number: u64, method: &str) -> Result<(), ForgeError> {
        match self.kind {
            ForgeKind::Gitlab => {
                if method == "rebase" {
                    return Err(ForgeError::Api("GitLab no fusiona con rebase desde la API; usá merge o squash".into()));
                }
                self.call(
                    Method::PUT,
                    &format!("/projects/{}/merge_requests/{number}/merge", gl_project(repo)),
                    Some(json!({ "squash": method == "squash" })),
                )
                .await
                .map(|_| ())
            }
            ForgeKind::Github => self
                .call(Method::PUT, &format!("/repos/{repo}/pulls/{number}/merge"), Some(json!({ "merge_method": method })))
                .await
                .map(|_| ()),
            _ => self
                .call(Method::POST, &format!("/repos/{repo}/pulls/{number}/merge"), Some(json!({ "Do": method })))
                .await
                .map(|_| ()),
        }
    }

    pub async fn default_branch(&self, repo: &str) -> Result<Option<String>, ForgeError> {
        let path = match self.kind {
            ForgeKind::Gitlab => format!("/projects/{}", gl_project(repo)),
            _ => format!("/repos/{repo}"),
        };
        Ok(s(&self.get(&path).await?, "/default_branch"))
    }

    /// Un repo por su ruta (`owner/nombre`). `None` si no existe o la cuenta no lo ve.
    pub async fn find_repo(&self, full_name: &str) -> Result<Option<ForgeRepo>, ForgeError> {
        let path = match self.kind {
            ForgeKind::Gitlab => format!("/projects/{}", gl_project(full_name)),
            _ => format!("/repos/{full_name}"),
        };
        match self.get(&path).await {
            Ok(v) => Ok(Some(self.repo_from(&v))),
            Err(ForgeError::Api(m)) if m.starts_with("Not found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Crea un repo PRIVADO en la cuenta, vacío (sin README: el primer commit lo hace la
    /// app, así no hay historia que mezclar).
    pub async fn create_private_repo(&self, name: &str, description: &str) -> Result<ForgeRepo, ForgeError> {
        let v = match self.kind {
            ForgeKind::Gitlab => {
                self.call(
                    Method::POST,
                    "/projects",
                    Some(json!({ "name": name, "path": name, "visibility": "private", "description": description })),
                )
                .await?
            }
            // GitHub y Gitea: el mismo endpoint y los mismos campos.
            _ => {
                self.call(
                    Method::POST,
                    "/user/repos",
                    Some(json!({ "name": name, "private": true, "description": description, "auto_init": false })),
                )
                .await?
            }
        };
        Ok(self.repo_from(&v))
    }

    /// El commit de la cabeza de un PR: sobre él corre el CI.
    pub async fn pull_head_sha(&self, repo: &str, number: u64) -> Result<String, ForgeError> {
        let v = match self.kind {
            ForgeKind::Gitlab => self.get(&format!("/projects/{}/merge_requests/{number}", gl_project(repo))).await?,
            _ => self.get(&format!("/repos/{repo}/pulls/{number}")).await?,
        };
        match self.kind {
            ForgeKind::Gitlab => s(&v, "/sha"),
            _ => s(&v, "/head/sha"),
        }
        .ok_or_else(|| ForgeError::Api("La API no dijo el commit del PR".into()))
    }

    /// Los chequeos de CI de un commit.
    pub async fn checks(&self, repo: &str, sha: &str) -> Result<Vec<Check>, ForgeError> {
        match self.kind {
            ForgeKind::Github => {
                let runs = self.get(&format!("/repos/{repo}/commits/{sha}/check-runs?per_page=100")).await?;
                // Los statuses viejos pueden no existir; su falta no es un error.
                let combined = self.get(&format!("/repos/{repo}/commits/{sha}/status")).await.unwrap_or(Value::Null);
                Ok(github_checks(&runs, &combined))
            }
            ForgeKind::Gitlab => {
                let project = gl_project(repo);
                let pipelines = self.get_list(&format!("/projects/{project}/pipelines?sha={sha}&per_page=1")).await?;
                let Some(id) = pipelines.first().and_then(|p| n(p, "/id")) else { return Ok(Vec::new()) };
                let jobs = self.get_list(&format!("/projects/{project}/pipelines/{id}/jobs?per_page=100")).await?;
                Ok(gitlab_checks(&jobs))
            }
            _ => Ok(gitea_checks(&self.get(&format!("/repos/{repo}/commits/{sha}/status")).await?)),
        }
    }

    /// Los archivos que toca un PR, con su diff cuando el host lo da. Hasta 300: más que
    /// eso no entra en ningún contexto.
    pub async fn pull_files(&self, repo: &str, number: u64) -> Result<Vec<PullFile>, ForgeError> {
        match self.kind {
            ForgeKind::Github => {
                let mut all = Vec::new();
                for page in 1..=3 {
                    let items = self.get_list(&format!("/repos/{repo}/pulls/{number}/files?per_page=100&page={page}")).await?;
                    let count = items.len();
                    all.extend(items.iter().map(|f| PullFile {
                        path: s(f, "/filename").unwrap_or_default(),
                        old_path: s(f, "/previous_filename"),
                        status: s(f, "/status").map(|st| if st == "changed" { "modified".into() } else { st }).unwrap_or_default(),
                        additions: n(f, "/additions").unwrap_or(0),
                        deletions: n(f, "/deletions").unwrap_or(0),
                        patch: s(f, "/patch"),
                    }));
                    if count < 100 {
                        break;
                    }
                }
                Ok(all)
            }
            ForgeKind::Gitlab => {
                let project = gl_project(repo);
                // `/diffs` desde GitLab 15.7; antes, los mismos datos en `/changes`.
                let items = match self.get_list(&format!("/projects/{project}/merge_requests/{number}/diffs?per_page=100")).await {
                    Ok(items) => items,
                    Err(_) => self
                        .get(&format!("/projects/{project}/merge_requests/{number}/changes"))
                        .await?
                        .get("changes")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                };
                Ok(items
                    .iter()
                    .map(|f| {
                        let patch = s(f, "/diff");
                        let (additions, deletions) = patch.as_deref().map(count_patch).unwrap_or((0, 0));
                        let status = if b(f, "/new_file") {
                            "added"
                        } else if b(f, "/deleted_file") {
                            "removed"
                        } else if b(f, "/renamed_file") {
                            "renamed"
                        } else {
                            "modified"
                        };
                        let new_path = s(f, "/new_path").unwrap_or_default();
                        PullFile {
                            old_path: s(f, "/old_path").filter(|o| *o != new_path),
                            path: new_path,
                            status: status.into(),
                            additions,
                            deletions,
                            patch,
                        }
                    })
                    .collect())
            }
            _ => {
                let items = self.get_list(&format!("/repos/{repo}/pulls/{number}/files?limit=100")).await?;
                // Gitea no manda el diff por archivo: sale del `.diff` del PR, partido.
                let raw = self.get(&format!("/repos/{repo}/pulls/{number}.diff")).await.ok();
                let patches = raw.as_ref().and_then(Value::as_str).map(split_diff).unwrap_or_default();
                Ok(items
                    .iter()
                    .map(|f| {
                        let path = s(f, "/filename").unwrap_or_default();
                        let patch = patches.iter().find(|(p, _)| *p == path).map(|(_, body)| body.clone());
                        PullFile {
                            old_path: s(f, "/previous_filename").filter(|o| !o.is_empty()),
                            status: s(f, "/status").unwrap_or_else(|| "modified".into()),
                            additions: n(f, "/additions").unwrap_or(0),
                            deletions: n(f, "/deletions").unwrap_or(0),
                            patch,
                            path,
                        }
                    })
                    .collect())
            }
        }
    }

    pub(super) fn release_from(&self, v: &Value) -> Release {
        match self.kind {
            ForgeKind::Gitlab => Release {
                tag: s(v, "/tag_name").unwrap_or_default(),
                name: s(v, "/name").unwrap_or_default(),
                body: s(v, "/description").filter(|b| !b.is_empty()),
                draft: false,
                prerelease: b(v, "/upcoming_release"),
                web_url: s(v, "/_links/self").unwrap_or_default(),
                created_at: s(v, "/released_at").or_else(|| s(v, "/created_at")),
                author: s(v, "/author/username"),
            },
            _ => Release {
                tag: s(v, "/tag_name").unwrap_or_default(),
                name: s(v, "/name").unwrap_or_default(),
                body: s(v, "/body").filter(|b| !b.is_empty()),
                draft: b(v, "/draft"),
                prerelease: b(v, "/prerelease"),
                web_url: s(v, "/html_url").unwrap_or_default(),
                created_at: s(v, "/published_at").or_else(|| s(v, "/created_at")),
                author: s(v, "/author/login"),
            },
        }
    }

    /// Las etiquetas del repo.
    pub async fn repo_labels(&self, repo: &str) -> Result<Vec<Label>, ForgeError> {
        let items = match self.kind {
            ForgeKind::Gitlab => self.get_list(&format!("/projects/{}/labels?per_page=100", gl_project(repo))).await?,
            ForgeKind::Github => self.get_list(&format!("/repos/{repo}/labels?per_page=100")).await?,
            _ => self.get_list(&format!("/repos/{repo}/labels?limit=50")).await?,
        };
        Ok(items.iter().filter_map(label_from).collect())
    }

    /// Las releases del repo, las más nuevas primero.
    pub async fn releases(&self, repo: &str) -> Result<Vec<Release>, ForgeError> {
        let items = match self.kind {
            ForgeKind::Gitlab => self.get_list(&format!("/projects/{}/releases?per_page=30", gl_project(repo))).await?,
            ForgeKind::Github => self.get_list(&format!("/repos/{repo}/releases?per_page=30")).await?,
            _ => self.get_list(&format!("/repos/{repo}/releases?limit=30")).await?,
        };
        Ok(items.iter().map(|v| self.release_from(v)).collect())
    }

    /// Publica una release. Si el tag no existe en el host, lo crea en `target` (o en la
    /// rama por defecto).
    pub async fn create_release(&self, repo: &str, new: &NewRelease) -> Result<Release, ForgeError> {
        let name = new.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| new.tag.clone());
        let body = new.body.clone().unwrap_or_default();
        let v = match self.kind {
            ForgeKind::Gitlab => {
                if new.draft {
                    return Err(ForgeError::Api("GitLab no tiene releases en borrador".into()));
                }
                let mut payload = json!({ "tag_name": new.tag, "name": name, "description": body });
                // `ref` solo hace falta si el tag no existe: GitLab lo crea ahí.
                let reference = match &new.target {
                    Some(t) => Some(t.clone()),
                    None => self.default_branch(repo).await?,
                };
                if let Some(r) = reference {
                    payload["ref"] = json!(r);
                }
                self.call(Method::POST, &format!("/projects/{}/releases", gl_project(repo)), Some(payload)).await?
            }
            _ => {
                let mut payload = json!({
                    "tag_name": new.tag, "name": name, "body": body,
                    "draft": new.draft, "prerelease": new.prerelease,
                });
                if let Some(t) = &new.target {
                    payload["target_commitish"] = json!(t);
                }
                self.call(Method::POST, &format!("/repos/{repo}/releases"), Some(payload)).await?
            }
        };
        Ok(self.release_from(&v))
    }

    /// La ref de git con la que el host publica la cabeza de un PR.
    pub fn pull_head_ref(&self, number: u64) -> String {
        match self.kind {
            ForgeKind::Gitlab => format!("refs/merge-requests/{number}/head"),
            _ => format!("refs/pull/{number}/head"),
        }
    }
}
