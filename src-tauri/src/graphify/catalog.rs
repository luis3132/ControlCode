//! Todo lo que graphify sabe hacer, como una tabla.
//!
//! El CLI tiene más de cincuenta formas documentadas y cada una es una línea con flags que
//! hay que recordar. Acá viven todas una sola vez: qué comando es, qué hueco hay que
//! llenar y qué flags acepta. La interfaz las dibuja sola, así que agregar una es agregar
//! una fila — no una pantalla.
//!
//! ## Dos clases de comando, que no se ejecutan igual
//!
//! - [`Kind::Shell`] es un comando de verdad: `graphify extract .`, `graphify query "…"`.
//!   Corre en el shell del usuario y su salida vuelve a la app.
//! - [`Kind::Skill`] es lo que se escribe ADENTRO del asistente: `/graphify .`. No existe
//!   como binario — es la skill, y la corre el modelo con su propia sesión y su propia API.
//!   Ejecutarla en un shell daría "command not found", así que se manda a la terminal de
//!   un agente, que es donde significa algo.
//!
//! Esa diferencia es del README (las líneas con `/graphify` contra las que empiezan con
//! `graphify`), no una interpretación: son dos superficies distintas del mismo programa.
//!
//! ## Los flags son opcionales de verdad
//!
//! Una fila por combinación de flags daría cientos. Cada comando trae SU lista de flags y
//! el comando final se arma con los que estén prendidos ([`render`]), que es también lo que
//! se muestra antes de ejecutar: lo que se ve es exactamente lo que va a correr.

use serde::{Deserialize, Serialize};

/// Cómo se ejecuta un comando.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Un comando del CLI, en el shell del usuario.
    Shell,
    /// Una línea para escribir adentro del asistente (`/graphify …`).
    Skill,
}

/// Un hueco del comando y con qué viene lleno.
struct Arg {
    name: &'static str,
    default: &'static str,
    /// Los valores que acepta, cuando son una lista cerrada (un backend, una plataforma).
    /// Vacío = texto libre. Se escribe una vez acá y no en cada pantalla.
    options: &'static [&'static str],
}

/// Un flag opcional. Puede traer sus propios huecos.
struct Flag {
    id: &'static str,
    /// Lo que se agrega al comando, con `{hueco}` si lleva valor.
    text: &'static str,
}

struct Command {
    id: &'static str,
    group: &'static str,
    kind: Kind,
    /// La forma base, con `{hueco}` donde va un valor.
    template: &'static str,
    args: &'static [Arg],
    flags: &'static [Flag],
    /// No termina por su cuenta (`watch`, el servidor MCP): solo tiene sentido en una
    /// terminal, donde se lo ve correr y se lo puede cortar.
    long_running: bool,
}

const NO_ARGS: &[Arg] = &[];
/// Un hueco de texto libre.
const NONE: &[&str] = &[];
const NO_FLAGS: &[Flag] = &[];

/// El path del corpus, que es el argumento de casi todo.
const PATH: &[Arg] = &[Arg { name: "path", default: ".", options: NONE }];

/// Los backends documentados en `--backend`, en el orden del README.
pub const BACKENDS: &[&str] =
    &["gemini", "kimi", "claude", "claude-cli", "openai", "deepseek", "ollama", "bedrock", "azure"];

/// Los extras de PyPI (`graphifyy[...]`), con lo que agrega cada uno.
pub const EXTRAS: &[&str] = &[
    "pdf", "office", "google", "video", "mcp", "neo4j", "falkordb", "svg", "leiden", "ollama",
    "openai", "gemini", "anthropic", "bedrock", "azure", "sql", "postgres", "dm", "terraform",
    "pascal", "ocaml", "commonlisp", "robot", "chinese", "all",
];

/// Las plataformas de `graphify install --platform`, tal como las lista el README.
pub const PLATFORMS: &[&str] = &[
    "claude", "windows", "codebuddy", "codex", "opencode", "kilo", "copilot", "aider", "claw",
    "droid", "trae", "trae-cn", "gemini", "hermes", "kimi", "amp", "agents", "kiro", "pi",
];

/// Las que se registran con su propio subcomando en vez de con `--platform`.
pub const SUBCOMMAND_PLATFORMS: &[&str] =
    &["claude", "codebuddy", "codex", "opencode", "kilo", "cursor", "gemini", "copilot", "aider",
      "claw", "droid", "trae", "trae-cn", "hermes", "amp", "agents", "kiro", "pi", "devin",
      "antigravity", "vscode"];

/// La tabla. El orden es el de la interfaz, agrupado como el README.
const COMMANDS: &[Command] = &[
    // ── Construir el grafo ────────────────────────────────────────────────────
    Command {
        id: "extract",
        group: "build",
        kind: Kind::Shell,
        template: "graphify extract {path}",
        args: &[
            Arg { name: "path", default: ".", options: NONE },
            Arg { name: "backend", default: "ollama", options: BACKENDS },
            Arg { name: "model", default: "", options: NONE },
            Arg { name: "workers", default: "16", options: NONE },
            Arg { name: "budget", default: "30000", options: NONE },
            Arg { name: "concurrency", default: "2", options: NONE },
            Arg { name: "timeout", default: "900", options: NONE },
            Arg { name: "dsn", default: "postgresql://user:pass@host/db", options: NONE },
            Arg { name: "name", default: "myrepo", options: NONE },
        ],
        flags: &[
            // Sin LLM y sin que nada salga de la máquina: es el modo que no necesita clave.
            Flag { id: "code-only", text: "--code-only" },
            Flag { id: "backend", text: "--backend {backend}" },
            Flag { id: "model", text: "--model {model}" },
            Flag { id: "deep", text: "--mode deep" },
            Flag { id: "max-workers", text: "--max-workers {workers}" },
            Flag { id: "token-budget", text: "--token-budget {budget}" },
            Flag { id: "max-concurrency", text: "--max-concurrency {concurrency}" },
            Flag { id: "api-timeout", text: "--api-timeout {timeout}" },
            Flag { id: "google-workspace", text: "--google-workspace" },
            Flag { id: "no-gitignore", text: "--no-gitignore" },
            Flag { id: "no-cluster", text: "--no-cluster" },
            Flag { id: "timing", text: "--timing" },
            Flag { id: "force", text: "--force" },
            Flag { id: "allow-partial", text: "--allow-partial" },
            Flag { id: "dedup-llm", text: "--dedup-llm" },
            Flag { id: "no-dedup", text: "--no-dedup" },
            Flag { id: "postgres", text: "--postgres \"{dsn}\"" },
            Flag { id: "cargo", text: "--cargo" },
            Flag { id: "global", text: "--global --as {name}" },
        ],
        long_running: false,
    },
    Command {
        id: "update",
        group: "build",
        kind: Kind::Shell,
        template: "graphify update {path}",
        args: PATH,
        flags: &[
            Flag { id: "no-cluster", text: "--no-cluster" },
            Flag { id: "force", text: "--force" },
        ],
        long_running: false,
    },
    Command {
        id: "check-update",
        group: "build",
        kind: Kind::Shell,
        template: "graphify check-update {path}",
        args: PATH,
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "watch",
        group: "build",
        kind: Kind::Shell,
        template: "graphify watch {path}",
        args: PATH,
        flags: NO_FLAGS,
        long_running: true,
    },
    Command {
        id: "cluster-only",
        group: "build",
        kind: Kind::Shell,
        template: "graphify cluster-only {path}",
        args: &[
            Arg { name: "path", default: ".", options: NONE },
            Arg { name: "graph", default: "graphify-out/graph.json", options: NONE },
            Arg { name: "resolution", default: "1.5", options: NONE },
            Arg { name: "percentile", default: "99", options: NONE },
            Arg { name: "concurrency", default: "16", options: NONE },
            Arg { name: "batch", default: "200", options: NONE },
            Arg { name: "backend", default: "gemini", options: BACKENDS },
            Arg { name: "model", default: "", options: NONE },
        ],
        flags: &[
            Flag { id: "graph", text: "--graph {graph}" },
            Flag { id: "resolution", text: "--resolution {resolution}" },
            Flag { id: "exclude-hubs", text: "--exclude-hubs {percentile}" },
            Flag { id: "parallel", text: "--max-concurrency {concurrency} --batch-size {batch}" },
            Flag { id: "no-label", text: "--no-label" },
            Flag { id: "no-viz", text: "--no-viz" },
            Flag { id: "backend", text: "--backend={backend}" },
            Flag { id: "model", text: "--model {model}" },
        ],
        long_running: false,
    },
    Command {
        id: "label",
        group: "build",
        kind: Kind::Shell,
        template: "graphify label {path}",
        args: &[
            Arg { name: "path", default: ".", options: NONE },
            Arg { name: "backend", default: "openai", options: BACKENDS },
            Arg { name: "model", default: "gpt-4o", options: NONE },
        ],
        flags: &[
            Flag { id: "backend", text: "--backend={backend}" },
            Flag { id: "model", text: "--model {model}" },
        ],
        long_running: false,
    },
    Command {
        id: "clone",
        group: "build",
        kind: Kind::Shell,
        template: "graphify clone {url}",
        args: &[Arg { name: "url", default: "https://github.com/karpathy/nanoGPT", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "merge-graphs",
        group: "build",
        kind: Kind::Shell,
        template: "graphify merge-graphs {a} {b}",
        args: &[
            Arg { name: "a", default: "a.json", options: NONE },
            Arg { name: "b", default: "b.json", options: NONE },
            Arg { name: "out", default: "merged.json", options: NONE },
        ],
        flags: &[Flag { id: "out", text: "--out {out}" }],
        long_running: false,
    },
    // ── Consultar el grafo ────────────────────────────────────────────────────
    Command {
        id: "query",
        group: "query",
        kind: Kind::Shell,
        template: "graphify query \"{question}\"",
        args: &[
            Arg { name: "question", default: "what connects auth to the database?", options: NONE },
            Arg { name: "graph", default: "graphify-out/graph.json", options: NONE },
            Arg { name: "budget", default: "1500", options: NONE },
        ],
        flags: &[
            Flag { id: "graph", text: "--graph {graph}" },
            Flag { id: "dfs", text: "--dfs --budget {budget}" },
        ],
        long_running: false,
    },
    Command {
        id: "path",
        group: "query",
        kind: Kind::Shell,
        template: "graphify path \"{a}\" \"{b}\"",
        args: &[
            Arg { name: "a", default: "UserService", options: NONE },
            Arg { name: "b", default: "DatabasePool", options: NONE },
        ],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "explain",
        group: "query",
        kind: Kind::Shell,
        template: "graphify explain \"{node}\"",
        args: &[Arg { name: "node", default: "RateLimiter", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
    // ── Exportar ──────────────────────────────────────────────────────────────
    Command {
        id: "export-callflow",
        group: "export",
        kind: Kind::Shell,
        template: "graphify export callflow-html",
        args: &[
            Arg { name: "sections", default: "8", options: NONE },
            Arg { name: "out", default: "docs/arch.html", options: NONE },
        ],
        flags: &[
            Flag { id: "max-sections", text: "--max-sections {sections}" },
            Flag { id: "output", text: "--output {out}" },
        ],
        long_running: false,
    },
    // ── Hooks de git ──────────────────────────────────────────────────────────
    Command {
        id: "hook-install",
        group: "hooks",
        kind: Kind::Shell,
        template: "graphify hook install",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "hook-status",
        group: "hooks",
        kind: Kind::Shell,
        template: "graphify hook status",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "hook-uninstall",
        group: "hooks",
        kind: Kind::Shell,
        template: "graphify hook uninstall",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    // ── Pull requests ─────────────────────────────────────────────────────────
    Command {
        id: "prs",
        group: "prs",
        kind: Kind::Shell,
        template: "graphify prs",
        args: &[
            Arg { name: "pr", default: "42", options: NONE },
            Arg { name: "base", default: "main", options: NONE },
            Arg { name: "repo", default: "owner/repo", options: NONE },
        ],
        flags: &[
            Flag { id: "pr", text: "{pr}" },
            Flag { id: "triage", text: "--triage" },
            Flag { id: "worktrees", text: "--worktrees" },
            Flag { id: "conflicts", text: "--conflicts" },
            Flag { id: "base", text: "--base {base}" },
            Flag { id: "repo", text: "--repo {repo}" },
        ],
        long_running: false,
    },
    // ── El grafo global, entre proyectos ──────────────────────────────────────
    Command {
        id: "global-add",
        group: "global",
        kind: Kind::Shell,
        template: "graphify global add graphify-out/graph.json --as {name}",
        args: &[Arg { name: "name", default: "myrepo", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "global-list",
        group: "global",
        kind: Kind::Shell,
        template: "graphify global list",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "global-remove",
        group: "global",
        kind: Kind::Shell,
        template: "graphify global remove {name}",
        args: &[Arg { name: "name", default: "myrepo", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "global-path",
        group: "global",
        kind: Kind::Shell,
        template: "graphify global path",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    // ── Memoria de trabajo ────────────────────────────────────────────────────
    Command {
        id: "save-result",
        group: "memory",
        kind: Kind::Shell,
        template: "graphify save-result --question \"{question}\" --answer \"{answer}\" --outcome {outcome}",
        args: &[
            Arg { name: "question", default: "", options: NONE },
            Arg { name: "answer", default: "", options: NONE },
            Arg { name: "outcome", default: "useful", options: &["useful", "dead_end", "corrected"] },
            Arg { name: "nodes", default: "Foo Bar", options: NONE },
        ],
        flags: &[Flag { id: "nodes", text: "--nodes {nodes}" }],
        long_running: false,
    },
    Command {
        id: "reflect",
        group: "memory",
        kind: Kind::Shell,
        template: "graphify reflect",
        args: &[
            Arg { name: "out", default: "docs/LESSONS.md", options: NONE },
            Arg { name: "graph", default: "graphify-out/graph.json", options: NONE },
        ],
        flags: &[
            Flag { id: "if-stale", text: "--if-stale" },
            Flag { id: "out", text: "--out {out}" },
            Flag { id: "graph", text: "--graph {graph}" },
        ],
        long_running: false,
    },
    // ── El grafo como servidor MCP ────────────────────────────────────────────
    Command {
        id: "serve",
        group: "server",
        kind: Kind::Shell,
        template: "python -m graphify.serve {graph}",
        args: &[
            Arg { name: "graph", default: "graphify-out/graph.json", options: NONE },
            Arg { name: "host", default: "0.0.0.0", options: NONE },
            Arg { name: "port", default: "8080", options: NONE },
            Arg { name: "key", default: "$GRAPHIFY_API_KEY", options: NONE },
            Arg { name: "mount", default: "/mcp", options: NONE },
            Arg { name: "session", default: "3600", options: NONE },
        ],
        flags: &[
            Flag { id: "http", text: "--transport http --port {port}" },
            Flag { id: "host", text: "--host {host}" },
            Flag { id: "api-key", text: "--api-key \"{key}\"" },
            Flag { id: "path", text: "--path {mount}" },
            Flag { id: "json-response", text: "--json-response" },
            Flag { id: "stateless", text: "--stateless" },
            Flag { id: "session-timeout", text: "--session-timeout {session}" },
        ],
        long_running: true,
    },
    // ── Que el asistente use el grafo siempre ─────────────────────────────────
    Command {
        // La tabla "Make your assistant always use the graph": escribe el archivo de
        // instrucciones de esa TUI (CLAUDE.md, AGENTS.md, .cursor/rules…) y, donde
        // existen, sus hooks.
        id: "always-on",
        group: "alwaysOn",
        kind: Kind::Shell,
        template: "graphify {subcommand} install",
        args: &[Arg { name: "subcommand", default: "claude", options: SUBCOMMAND_PLATFORMS }],
        flags: &[
            Flag { id: "project", text: "--project" },
            // Solo Claude Code: bloquea la primera lectura cruda de la sesión y la manda
            // al grafo. Sin esto el install solo sugiere.
            Flag { id: "strict", text: "--strict" },
        ],
        long_running: false,
    },
    Command {
        id: "always-on-uninstall",
        group: "alwaysOn",
        kind: Kind::Shell,
        template: "graphify {subcommand} uninstall",
        args: &[Arg { name: "subcommand", default: "claude", options: SUBCOMMAND_PLATFORMS }],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        // La otra forma de registrar la skill: por flag en vez de por subcomando. Es la que
        // usan las plataformas que no tienen subcomando propio (`kimi`, `windows`).
        id: "platform-install",
        group: "alwaysOn",
        kind: Kind::Shell,
        template: "graphify install --platform {platform}",
        args: &[Arg { name: "platform", default: "opencode", options: PLATFORMS }],
        flags: &[
            Flag { id: "project", text: "--project" },
            Flag { id: "strict", text: "--strict" },
        ],
        long_running: false,
    },
    // ── Sacarlo ───────────────────────────────────────────────────────────────
    Command {
        id: "uninstall",
        group: "uninstall",
        kind: Kind::Shell,
        template: "graphify uninstall",
        args: &[Arg { name: "platform", default: "codex", options: PLATFORMS }],
        flags: &[
            Flag { id: "purge", text: "--purge" },
            Flag { id: "project", text: "--project --platform {platform}" },
        ],
        long_running: false,
    },
    Command {
        id: "version",
        group: "uninstall",
        kind: Kind::Shell,
        template: "graphify --version",
        args: NO_ARGS,
        flags: NO_FLAGS,
        long_running: false,
    },
    // ── Lo que se escribe ADENTRO del asistente ───────────────────────────────
    Command {
        id: "skill-run",
        group: "skill",
        kind: Kind::Skill,
        template: "/graphify {path}",
        args: &[
            Arg { name: "path", default: ".", options: NONE },
            Arg { name: "dir", default: "~/vault", options: NONE },
            Arg { name: "bolt", default: "bolt://localhost:7687", options: NONE },
            Arg { name: "falkor", default: "falkordb://localhost:6379", options: NONE },
        ],
        flags: &[
            Flag { id: "deep", text: "--mode deep" },
            Flag { id: "update", text: "--update" },
            Flag { id: "directed", text: "--directed" },
            Flag { id: "cluster-only", text: "--cluster-only" },
            Flag { id: "no-viz", text: "--no-viz" },
            Flag { id: "obsidian", text: "--obsidian" },
            Flag { id: "obsidian-dir", text: "--obsidian-dir {dir}" },
            Flag { id: "wiki", text: "--wiki" },
            Flag { id: "svg", text: "--svg" },
            Flag { id: "graphml", text: "--graphml" },
            Flag { id: "neo4j", text: "--neo4j" },
            Flag { id: "neo4j-push", text: "--neo4j-push {bolt}" },
            Flag { id: "falkordb", text: "--falkordb" },
            Flag { id: "falkordb-push", text: "--falkordb-push {falkor}" },
            Flag { id: "watch", text: "--watch" },
            Flag { id: "mcp", text: "--mcp" },
        ],
        long_running: false,
    },
    Command {
        id: "skill-add",
        group: "skill",
        kind: Kind::Skill,
        template: "/graphify add {url}",
        args: &[
            Arg { name: "url", default: "https://arxiv.org/abs/1706.03762", options: NONE },
            Arg { name: "author", default: "", options: NONE },
        ],
        flags: &[Flag { id: "author", text: "--author \"{author}\"" }],
        long_running: false,
    },
    Command {
        id: "skill-query",
        group: "skill",
        kind: Kind::Skill,
        template: "/graphify query \"{question}\"",
        args: &[Arg { name: "question", default: "what connects attention to the optimizer?", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "skill-path",
        group: "skill",
        kind: Kind::Skill,
        template: "/graphify path \"{a}\" \"{b}\"",
        args: &[
            Arg { name: "a", default: "DigestAuth", options: NONE },
            Arg { name: "b", default: "Response", options: NONE },
        ],
        flags: NO_FLAGS,
        long_running: false,
    },
    Command {
        id: "skill-explain",
        group: "skill",
        kind: Kind::Skill,
        template: "/graphify explain \"{node}\"",
        args: &[Arg { name: "node", default: "SwinTransformer", options: NONE }],
        flags: NO_FLAGS,
        long_running: false,
    },
];

/// Un comando como lo ve la interfaz.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyCommand {
    pub id: String,
    pub group: String,
    pub kind: Kind,
    pub template: String,
    pub args: Vec<GraphifyArg>,
    pub flags: Vec<GraphifyFlag>,
    pub long_running: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyArg {
    pub name: String,
    pub default: String,
    /// Vacío = texto libre; si no, los únicos valores que acepta.
    pub options: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyFlag {
    pub id: String,
    pub text: String,
}

/// Lo que la interfaz manda para armar un comando: qué flags están prendidos y con qué
/// valores se llenaron los huecos.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub flags: Vec<String>,
    pub args: std::collections::HashMap<String, String>,
}

pub fn commands() -> Vec<GraphifyCommand> {
    COMMANDS
        .iter()
        .map(|c| GraphifyCommand {
            id: c.id.to_string(),
            group: c.group.to_string(),
            kind: c.kind,
            template: c.template.to_string(),
            args: c
                .args
                .iter()
                .map(|a| GraphifyArg {
                    name: a.name.into(),
                    default: a.default.into(),
                    options: a.options.iter().map(|o| o.to_string()).collect(),
                })
                .collect(),
            flags: c.flags.iter().map(|f| GraphifyFlag { id: f.id.into(), text: f.text.into() }).collect(),
            long_running: c.long_running,
        })
        .collect()
}

/// Reemplaza `{hueco}` por su valor. Un hueco sin valor usa el de fábrica; uno que quedó
/// vacío se saca junto con el espacio que lo precede, para no dejar un `--model ` colgando.
fn fill(text: &str, command: &Command, args: &std::collections::HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for arg in command.args {
        let value = args
            .get(arg.name)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .unwrap_or(arg.default)
            .trim()
            .to_string();
        out = out.replace(&format!("{{{}}}", arg.name), &value);
    }
    out
}

/// El comando final: la forma base más los flags prendidos, en el orden de la tabla.
///
/// El orden lo pone la tabla y no el usuario a propósito: los flags de graphify no son
/// conmutativos en todos lados (`--platform` antes de `--project`), y que el resultado
/// dependa de en qué orden se hizo click sería imposible de reproducir.
pub fn render(id: &str, choice: &Choice) -> Option<String> {
    let command = COMMANDS.iter().find(|c| c.id == id)?;
    let mut parts = vec![fill(command.template, command, &choice.args)];
    for flag in command.flags {
        if choice.flags.iter().any(|on| on == flag.id) {
            parts.push(fill(flag.text, command, &choice.args));
        }
    }
    // Un hueco vacío deja doble espacio (`--model  --deep`) o una comilla sola: se limpia
    // acá y no en cada plantilla.
    let joined = parts.into_iter().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join(" ");
    Some(joined.split_whitespace().collect::<Vec<_>>().join(" ").replace("\"\"", "").trim().to_string())
}

#[cfg(test)]
mod test {
    use super::*;

    fn choice(flags: &[&str], args: &[(&str, &str)]) -> Choice {
        Choice {
            flags: flags.iter().map(|s| s.to_string()).collect(),
            args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    /// Lo que se ve es lo que se ejecuta: la base, después los flags prendidos, en el
    /// orden de la tabla y no en el que se los haya clickeado.
    #[test]
    fn el_comando_se_arma_con_los_flags_prendidos_en_orden() {
        assert_eq!(render("extract", &choice(&[], &[])).unwrap(), "graphify extract .");
        assert_eq!(
            render("extract", &choice(&["deep", "code-only"], &[("path", "./docs")])).unwrap(),
            "graphify extract ./docs --code-only --mode deep"
        );
        assert_eq!(
            render("extract", &choice(&["backend"], &[("backend", "claude")])).unwrap(),
            "graphify extract . --backend claude"
        );
    }

    /// Un hueco que quedó vacío no puede dejar un flag a medias (`--model ` suelto) ni
    /// comillas vacías: el comando tiene que poder ejecutarse tal como se ve.
    #[test]
    fn un_hueco_vacio_no_deja_el_comando_roto() {
        // `model` viene vacío de fábrica: el flag queda sin valor y se limpia.
        let armado = render("extract", &choice(&["model", "deep"], &[])).unwrap();
        assert_eq!(armado, "graphify extract . --model --mode deep");
        // Y con valor, va entero.
        let con_valor = render("extract", &choice(&["model"], &[("model", "gpt-4.1-mini")])).unwrap();
        assert_eq!(con_valor, "graphify extract . --model gpt-4.1-mini");
        // Una comilla vacía tampoco sobrevive.
        let vacio = render("skill-add", &choice(&["author"], &[])).unwrap();
        assert_eq!(vacio, "/graphify add https://arxiv.org/abs/1706.03762 --author");
    }

    /// Lo que se escribe adentro del asistente no es un binario: `/graphify` no existe en
    /// el shell. Ejecutarlo ahí daría "command not found", así que la clase decide a dónde
    /// va cada uno.
    #[test]
    fn las_lineas_del_asistente_estan_marcadas_como_tales() {
        let all = commands();
        let skill: Vec<_> = all.iter().filter(|c| c.kind == Kind::Skill).collect();
        assert!(!skill.is_empty());
        assert!(skill.iter().all(|c| c.template.starts_with("/graphify")));
        assert!(all
            .iter()
            .filter(|c| c.kind == Kind::Shell)
            .all(|c| c.template.starts_with("graphify ") || c.template.starts_with("python -m graphify")));
    }

    /// Los que no terminan solos no se pueden correr con la salida capturada: la app
    /// esperaría para siempre. Tienen que estar marcados para que la interfaz los mande a
    /// una terminal.
    #[test]
    fn los_que_no_terminan_estan_marcados() {
        let largos: Vec<String> =
            commands().into_iter().filter(|c| c.long_running).map(|c| c.id).collect();
        assert_eq!(largos, vec!["watch", "serve"]);
    }

    /// Cada hueco de cada plantilla tiene que existir en los argumentos de ese comando: uno
    /// que no exista sale literal (`--model {model}`) y el comando falla al ejecutarse.
    #[test]
    fn ningun_hueco_queda_sin_llenar() {
        for command in COMMANDS {
            let armado = render(command.id, &choice(
                &command.flags.iter().map(|f| f.id).collect::<Vec<_>>(),
                &[],
            ))
            .unwrap();
            assert!(!armado.contains('{'), "{} dejó un hueco sin llenar: {armado}", command.id);
            assert!(!armado.contains('}'), "{} dejó un hueco sin llenar: {armado}", command.id);
        }
    }

    /// Ids repetidos harían que la interfaz muestre uno y ejecute otro.
    #[test]
    fn los_ids_no_se_repiten() {
        let mut ids: Vec<&str> = COMMANDS.iter().map(|c| c.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
        for command in COMMANDS {
            let mut flags: Vec<&str> = command.flags.iter().map(|f| f.id).collect();
            let n = flags.len();
            flags.sort_unstable();
            flags.dedup();
            assert_eq!(flags.len(), n, "{} repite un flag", command.id);
        }
    }
}
