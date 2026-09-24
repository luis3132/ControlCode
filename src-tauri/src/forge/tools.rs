//! Las tools de git remoto que el MCP de la app le ofrece a los agentes.
//!
//! El agente pide ("listá los PRs", "subí la rama", "abrí un issue") y la app lo hace con
//! la cuenta de git del usuario. El token nunca llega al agente: ni en el entorno de su
//! terminal ni en una respuesta. Por eso además `git push` desde la terminal del agente
//! no tiene credenciales, y la descripción de `git_push` se lo dice.
//!
//! Las que solo leen se aprueban solas en Claude Code (ver `ipc::mcp::tab_browser_mcp`);
//! las que escriben en el host (crear, comentar, subir) las aprueba la persona.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::api::{normalize_state, Api, Item, ItemDetail, NewIssue, NewPull};
use super::credentials::{api_for, target, token};
use super::provider::ForgeError;
use super::store::{self, db};

pub(crate) struct GitTool {
    pub name: &'static str,
    pub description: &'static str,
    pub properties: fn() -> Value,
    pub required: &'static [&'static str],
    /// Solo lee: se puede aprobar sola.
    pub read_only: bool,
}

fn none() -> Value {
    json!({})
}

fn state_prop(pr: bool) -> Value {
    let states: &[&str] = if pr { &["open", "closed", "merged", "all"] } else { &["open", "closed", "all"] };
    json!({ "state": { "type": "string", "enum": states, "description": "Default: open." } })
}

fn number_prop() -> Value {
    json!({ "number": { "type": "integer", "description": "The PR/MR or issue number (GitLab: the iid)." } })
}

pub(crate) const GIT_TOOLS: &[GitTool] = &[
    GitTool {
        name: "git_account",
        description: "Which git host, repository and Control Code account this project uses (no token is ever shown). Call it first when a git_* tool fails, to see whether the user still has to sign in.",
        properties: none,
        required: &[],
        read_only: true,
    },
    GitTool {
        name: "git_repos",
        description: "List the remote repositories the user's git accounts can access (GitHub, GitLab, Gitea…), most recently updated first, with their clone URLs.",
        properties: || json!({ "query": { "type": "string", "description": "Only repos whose name contains this text." } }),
        required: &[],
        read_only: true,
    },
    GitTool {
        name: "git_pr_list",
        description: "List this repository's pull requests (merge requests on GitLab).",
        properties: || state_prop(true),
        required: &[],
        read_only: true,
    },
    GitTool {
        name: "git_pr_view",
        description: "Read one pull request: description, branches, state and its comment thread.",
        properties: number_prop,
        required: &["number"],
        read_only: true,
    },
    GitTool {
        name: "git_issue_list",
        description: "List this repository's issues.",
        properties: || state_prop(false),
        required: &[],
        read_only: true,
    },
    GitTool {
        name: "git_issue_view",
        description: "Read one issue: description, state, labels and its comment thread.",
        properties: number_prop,
        required: &["number"],
        read_only: true,
    },
    GitTool {
        name: "git_fetch",
        description: "git fetch --all --prune with the user's Control Code git account. Use it instead of running `git fetch` in the shell, which has no credentials for private repos.",
        properties: none,
        required: &[],
        read_only: true,
    },
    GitTool {
        name: "git_pull",
        description: "git pull on the current branch, authenticated with the user's Control Code git account. Use it instead of `git pull` in the shell.",
        properties: none,
        required: &[],
        read_only: false,
    },
    GitTool {
        name: "git_push",
        description: "Push the current branch, authenticated with the user's Control Code git account (publishes it with upstream the first time). Use it instead of `git push` in the shell, which has no credentials. Commit first.",
        properties: none,
        required: &[],
        read_only: false,
    },
    GitTool {
        name: "git_pr_create",
        description: "Open a pull request (merge request on GitLab). The head branch must already be pushed: call git_push first.",
        properties: || json!({
            "title": { "type": "string" },
            "body": { "type": "string", "description": "Markdown description." },
            "head": { "type": "string", "description": "Source branch. Default: the current branch." },
            "base": { "type": "string", "description": "Target branch. Default: the repository's default branch." },
            "draft": { "type": "boolean" },
        }),
        required: &["title"],
        read_only: false,
    },
    GitTool {
        name: "git_issue_create",
        description: "Open an issue in this repository.",
        properties: || json!({
            "title": { "type": "string" },
            "body": { "type": "string", "description": "Markdown description." },
            "labels": { "type": "array", "items": { "type": "string" }, "description": "Existing label names (ignored on Gitea)." },
        }),
        required: &["title"],
        read_only: false,
    },
    GitTool {
        name: "git_comment",
        description: "Comment on an issue or a pull request.",
        properties: || json!({
            "number": { "type": "integer" },
            "body": { "type": "string", "description": "Markdown." },
            "pr": { "type": "boolean", "description": "true when `number` is a pull/merge request. Required on GitLab, where PRs and issues are numbered separately." },
        }),
        required: &["number", "body"],
        read_only: false,
    },
];

/// Qué carpeta pide: la de la tab, o la del worktree de la tarea.
fn cwd_of(app: &AppHandle, payload: &Value) -> Result<String, String> {
    if let Some(task_id) = payload.get("taskId").and_then(Value::as_str) {
        let conn = db(app)?;
        let conn = conn.lock().unwrap();
        return conn
            .query_row("SELECT cwd FROM tasks WHERE id = ?1", [task_id], |r| r.get::<_, String>(0))
            .map_err(|_| format!("no task {task_id}"));
    }
    payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing cwd or taskId".to_string())
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_number(args: &Value) -> Result<u64, String> {
    args.get("number").and_then(Value::as_u64).ok_or_else(|| "missing `number`".to_string())
}

fn item_line(i: &Item) -> String {
    let mut line = format!("#{} [{}{}] {}", i.number, i.state, if i.draft { ", draft" } else { "" }, i.title);
    if let Some(a) = &i.author {
        line.push_str(&format!(" — @{a}"));
    }
    if let (Some(h), Some(b)) = (&i.source_branch, &i.target_branch) {
        line.push_str(&format!(" ({h} → {b})"));
    }
    if !i.labels.is_empty() {
        line.push_str(&format!(" {{{}}}", i.labels.join(", ")));
    }
    line.push_str(&format!("\n  {}", i.web_url));
    line
}

fn list_text(items: &[Item], what: &str) -> String {
    if items.is_empty() {
        return format!("No {what}.");
    }
    items.iter().map(item_line).collect::<Vec<_>>().join("\n")
}

fn detail_text(d: &ItemDetail) -> String {
    let mut out = item_line(&d.item);
    out.push_str("\n\n");
    out.push_str(d.body.as_deref().unwrap_or("(no description)"));
    for c in &d.thread {
        out.push_str(&format!(
            "\n\n--- @{} {}\n{}",
            c.author.as_deref().unwrap_or("?"),
            c.created_at.as_deref().unwrap_or(""),
            c.body
        ));
    }
    out
}

fn current_branch(root: &str) -> Result<String, String> {
    crate::scm::run_local(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("{e:?}"))
        .and_then(|b| if b == "HEAD" { Err("detached HEAD: check out a branch first".into()) } else { Ok(b) })
}

async fn call(app: &AppHandle, cwd: &str, name: &str, args: &Value) -> Result<String, ForgeError> {
    match name {
        "git_account" => {
            let t = target(app, cwd).await?;
            let mut out = format!(
                "Repository {} on {} (remote {} = {}).",
                t.path, t.host, t.remote, t.remote_url
            );
            match &t.account {
                Some(a) => {
                    out.push_str(&format!("\nSigned in as @{} ({:?}).", a.login, a.kind));
                    if t.accounts.len() > 1 {
                        out.push_str(&format!(" {} accounts exist for this host; the user picks which one in Source Control.", t.accounts.len()));
                    }
                    if t.ssh {
                        out.push_str("\nThe remote uses SSH: git_push/git_pull use the user's SSH key, the account is used for the API.");
                    }
                }
                None => out.push_str(&format!(
                    "\nNo Control Code account for {}: pull requests and issues are unavailable, and pushes use whatever git has configured. Ask the user to sign in under Accounts → Git.",
                    t.host
                )),
            }
            Ok(out)
        }
        "git_repos" => {
            let query = arg_str(args, "query").map(str::to_lowercase);
            // Dentro de un repo con cuenta, la de ese repo; si no, todas.
            let accounts = match target(app, cwd).await.ok().and_then(|t| t.account) {
                Some(a) => vec![a],
                None => store::list(&db(app)?.lock().unwrap()).into_iter().filter(|a| a.kind.has_api()).collect(),
            };
            if accounts.is_empty() {
                return Err(ForgeError::NoAccount("any host".into()));
            }
            let mut lines = Vec::new();
            for account in accounts {
                let token = token(app, &account).await?;
                let repos = Api::new(account.kind, &account.host, &token)?.repos().await?;
                for r in repos {
                    if query.as_ref().is_some_and(|q| !r.full_name.to_lowercase().contains(q)) {
                        continue;
                    }
                    lines.push(format!(
                        "{} ({}{}) {}{}",
                        r.full_name,
                        if r.private { "private" } else { "public" },
                        if r.archived { ", archived" } else { "" },
                        r.clone_url,
                        r.description.map(|d| format!(" — {d}")).unwrap_or_default()
                    ));
                    if lines.len() >= 200 {
                        break;
                    }
                }
            }
            Ok(if lines.is_empty() { "No repositories match.".into() } else { lines.join("\n") })
        }
        "git_fetch" | "git_pull" | "git_push" => {
            let t = target(app, cwd).await?;
            let op = match name {
                "git_fetch" => crate::scm::Sync::Fetch,
                "git_pull" => crate::scm::Sync::Pull,
                _ => crate::scm::Sync::Push,
            };
            crate::scm::sync(app, t.root, op).await.map(|out| {
                let out = out.trim();
                if out.is_empty() { "Done.".to_string() } else { out.to_string() }
            }).map_err(|e| match e {
                crate::scm::ScmError::Auth(m) => ForgeError::Auth(format!(
                    "git was refused credentials for {}: {m}\nThe user may need to sign in (or sign in again) under Accounts → Git.",
                    t.host
                )),
                crate::scm::ScmError::Git(m) => ForgeError::Api(m),
            })
        }
        _ => {
            let t = target(app, cwd).await?;
            let api = api_for(app, &t).await?;
            match name {
                "git_pr_list" => Ok(list_text(&api.pulls(&t.path, normalize_state(arg_str(args, "state"))).await?, "pull requests")),
                "git_issue_list" => Ok(list_text(&api.issues(&t.path, normalize_state(arg_str(args, "state"))).await?, "issues")),
                "git_pr_view" => Ok(detail_text(&api.item(&t.path, arg_number(args)?, true).await?)),
                "git_issue_view" => Ok(detail_text(&api.item(&t.path, arg_number(args)?, false).await?)),
                "git_pr_create" => {
                    let title = arg_str(args, "title").ok_or("missing `title`")?.to_string();
                    let head = match arg_str(args, "head") {
                        Some(h) => h.to_string(),
                        None => current_branch(&t.root)?,
                    };
                    let base = match arg_str(args, "base") {
                        Some(b) => b.to_string(),
                        None => api.default_branch(&t.path).await?.ok_or("could not read the default branch; pass `base`")?,
                    };
                    let pull = NewPull {
                        title,
                        body: arg_str(args, "body").map(str::to_string),
                        head,
                        base,
                        draft: args.get("draft").and_then(Value::as_bool).unwrap_or(false),
                    };
                    let item = api.create_pull(&t.path, &pull).await?;
                    Ok(format!("Created {}", item_line(&item)))
                }
                "git_issue_create" => {
                    let issue = NewIssue {
                        title: arg_str(args, "title").ok_or("missing `title`")?.to_string(),
                        body: arg_str(args, "body").map(str::to_string),
                        labels: args
                            .get("labels")
                            .and_then(Value::as_array)
                            .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect())
                            .unwrap_or_default(),
                    };
                    let item = api.create_issue(&t.path, &issue).await?;
                    Ok(format!("Created {}", item_line(&item)))
                }
                "git_comment" => {
                    let body = arg_str(args, "body").ok_or("missing `body`")?;
                    let number = arg_number(args)?;
                    let pr = args.get("pr").and_then(Value::as_bool).unwrap_or(false);
                    api.comment(&t.path, number, pr, body).await?;
                    Ok(format!("Commented on #{number}."))
                }
                other => Err(ForgeError::Api(format!("unknown git tool {other}"))),
            }
        }
    }
}

/// Lo que recibe la app desde `ccode mcp`: `{cwd|taskId, tool, args}`. Corre en un hilo
/// del servidor IPC (sin runtime), así que puede esperar la parte async con `block_on`.
pub(crate) fn run(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let cwd = cwd_of(app, payload)?;
    let tool = payload.get("tool").and_then(Value::as_str).ok_or("missing tool")?.to_string();
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    let text = tauri::async_runtime::block_on(call(app, &cwd, &tool, &args)).map_err(|e| e.to_string())?;
    Ok(json!({ "text": text }))
}
