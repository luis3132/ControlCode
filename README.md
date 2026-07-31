<div align="center">

# Control Code

**The command center for your AI coding agents.**

One desktop app to run Claude Code, Gemini CLI, Codex, OpenCode and Kimi Code side by side —
in real terminals, across real windows, with your skills and sessions under control.

*Local-first · Open source · Linux · macOS · Windows*

</div>

---

## Why

Working with coding agents means juggling terminals. One for the backend, one for the frontend, one for the migration you started yesterday and can no longer find. Every window is a different folder, a different agent, a different half-remembered context. Close your laptop and it's all gone.

Control Code turns that sprawl into something you can actually manage. Tabs like a browser, workspaces you can save and reopen, skills installed once and shared everywhere, and a searchable archive of every session you've ever run — so nothing is lost just because you closed a window.

And because agents should be able to drive their own tooling, it ships a CLI: your agent can open tabs, read their output and orchestrate a whole workspace on its own.

---

## What it does

### 🖥️ Real terminals, browser-like tabs

Every tab is a genuine pty running the agent of your choice in the working directory of your choice — or just a shell. Installed agents are auto-detected from your `PATH`, and anything else you use can be registered as a first-class agent.

**Supported out of the box:** Claude Code · Gemini CLI · Codex · OpenCode · Kimi Code · plain shell

### 🪟 Tear-off windows that don't kill your session

Drag a tab out of the tab bar and it becomes its own native OS window. Drop it onto another window's tab bar and it merges there.

**How it works:** the pty is *migrated*, not restarted. The process keeps running through the move, so a long agent session survives being reorganised. Window position, size and monitor are persisted and restored on next launch.

### 📂 Workspaces that survive a reboot

A workspace is a named layout of windows and tabs. Save the arrangement you're in, reopen it next week, and every tab returns with the same folder, the same agent, the same order — and its scrollback intact. Close the app entirely and it reopens where you left off.

### 🧩 Skills, installed once, attached anywhere

Install a skill once under `~/.controlcode/skills/`. Attach it wherever you need it.

**How it works:** Control Code creates **symlinks**, never copies. One canonical copy on disk, referenced from every project that uses it — update it once, every project sees the change.

| | |
|---|---|
| **Scoped** | Attach to a workspace and every tab in it gets the skill; attach to a tab and only that one does |
| **Ephemeral** | Symlinks exist on disk only while the window is open — opening a different workspace in the same folder never leaks the previous one's skills |
| **Per-agent** | `.claude/skills/` for Claude Code, `.agents/skills/` for the agents on the open Agent Skills standard |
| **Non-destructive** | Only symlinks into the global skills directory are managed. A skill folder you committed yourself is never touched |
| **Self-checking** | Broken or stale symlinks are detected when a workspace opens |

### 🛒 A marketplace for skills

Add skill repositories and install from them in one click. Paste a plain GitHub link — including a `/tree/branch/subfolder` URL — or point at a local folder. Repos with a `registry.json` manifest are read from it; repos without one are scanned automatically for `SKILL.md` files, with results cached locally.

Ships preconfigured with [autoskills](https://github.com/midudev/autoskills) and [anthropics/skills](https://github.com/anthropics/skills).

### 📜 Every session, archived and searchable

Close a tab and it's archived — along with the skills it had active and the other tabs that were open beside it.

- **Filter** by agent, folder, date range, skill, or free text
- **Reopen** a session and it comes back with the same skills reattached
- **Get warned first** if a skill is missing — told where to reinstall it from, with the option to install right there or continue without it
- **Export** to markdown: metadata plus the full conversation, read from the agent's own session files
- **Prune** entries from the history without touching the agent's files on disk

### 🤖 A CLI your agent can drive

`ccode` lets any agent orchestrate the app it's running inside. Ask Claude Code to *"open three tabs for this monorepo"* and it does it. Output is always one line of JSON — no scraping, no heuristics. See the [CLI reference](#cli-reference).

### ⚙️ Bring your own tool

Register any terminal tool as a first-class agent. Beyond a name and a command, you declare how deeply it integrates:

| Field | Enables |
|---|---|
| Resume arguments (`--resume {session}`) | Reopening a specific past session |
| Skills folder (`.agents/skills`) | Control Code managing its skills |
| Sessions folder + id source | Session discovery and readable titles |
| Environment variables | Injected when the process launches |

Everything past name and command is optional. A tool with just those two works fine — it simply opts out of the rest.

---

# Documentation

## Installation

**Requirements:** [Bun](https://bun.sh), a Rust toolchain, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/luis3132/ControlCode.git
cd ControlCode
bun install
bun run tauri dev
```

### Building a release bundle

```bash
bun run app:build
```

Produces `.deb`, `.rpm` and `.AppImage` on Linux, under `src-tauri/target/release/bundle/`.

> **Why `app:build` and not `tauri build`?** It sets `NO_STRIP=true`. The `strip` bundled with linuxdeploy fails on system libraries that use the modern `.relr.dyn` ELF section, which is standard on current distros. Skipping the strip step is the supported workaround.

### Running the tests

```bash
cd src-tauri && cargo test    # backend suite
bunx tsc --noEmit             # frontend type check
```

---

## CLI reference

Install `ccode` from **Settings → CLI**, which symlinks it into a directory on your `PATH`.

The CLI talks to the running app. All output is a single line of JSON on **stdout**; anything meant for humans (help, usage errors) goes to **stderr**.

### Commands

```
ccode <group> <action> [--flag value ...]
```

#### Tabs

| Command | Description |
|---|---|
| `tab list` | Tabs currently open |
| `tab create --cwd <path> --agent <id>` | Open a new tab. Optional: `--window <label>`, `--skills a,b` |
| `tab close --tab <id>` | Close a tab |
| `tab output --tab <id> [--lines 200]` | Last lines of its terminal |
| `tab send --tab <id> --text "..."` | Type into its terminal, then Enter. `--no-enter` to skip |

#### Windows

| Command | Description |
|---|---|
| `window list` | Open windows |
| `window create` | Open a new window |

#### Workspaces

| Command | Description |
|---|---|
| `workspace list` | Saved workspaces |
| `workspace open --workspace <id\|name>` | Open one. `--close-current` to replace |
| `workspace status` | What's open right now |

#### Skills

| Command | Description |
|---|---|
| `skill list` | Installed, plus what's available in enabled repos |
| `skill install --skill <name\|id>` | Install from the enabled repos |

#### Other

| Command | Description |
|---|---|
| `app status` | App version and state |
| `--json-args '{...}'` | Pass raw arguments as JSON |
| `--version` / `--help` | Version / usage |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The app rejected the command |
| `2` | Usage error |
| `3` | The app isn't running |

The distinct codes matter for agents: `3` means *start the app and retry*, while `1` means *the command itself was wrong*.

### Flag conventions

- Kebab-case flags become camelCase keys: `--close-current` → `closeCurrent`
- A flag with no value is a boolean: `--no-enter` → `true`
- `--skills a,b,c` is split into an array
- A value starting with `--` can't be parsed positionally — use `--json-args '{"text":"--flag"}"'` for those

### Orchestration skill

`skills/controlcode-orchestrator/SKILL.md` documents all of the above for an agent. Install it into Claude Code (or any agent that reads Agent Skills) and it can drive the app without you explaining the CLI first.

---

## How it works

### Architecture

```
┌─────────────────────────────────────────────────┐
│  React 19 + TypeScript + Tailwind v4 + Zustand  │
│  xterm.js terminals · one store per domain      │
└───────────────────────┬─────────────────────────┘
                        │  Tauri IPC (~60 commands)
┌───────────────────────┴─────────────────────────┐
│  Rust backend                                   │
│  ├─ terminal/   pty lifecycle (portable-pty)    │
│  ├─ skills/     symlink reconciliation          │
│  ├─ session/    discovery, titles, md export    │
│  ├─ marketplace/ registries, fetch + cache      │
│  ├─ window/     native windows, tear-off        │
│  ├─ agents/     PATH detection, custom TUIs     │
│  ├─ database/   SQLite schema + migrations      │
│  └─ ipc/        TCP server for the `ccode` CLI  │
└─────────────────────────────────────────────────┘
```

### Terminals

Each tab owns a pty created through `portable-pty`. The frontend measures the container and passes the real `cols`/`rows` at creation time rather than resizing after the fact — many TUIs read the terminal size once at startup and never redraw correctly after a later `SIGWINCH`, so getting it right from the first byte avoids the problem entirely.

Output is streamed to the frontend as Tauri events and mirrored into a capped in-memory scrollback buffer, which is what `ccode tab output` reads and what gets persisted when a workspace is saved.

### Skill symlinks

Attachment is stored as *intent* ("this skill belongs to this workspace / this tab"), not as a fixed path — a workspace-scoped skill may map to N tabs, and that set changes as tabs open and close.

The physical symlinks are **derived** from that intent on every attach, detach and workspace open, by reconciling the managed directory against the skills the live tabs actually ask for. Anything in that directory that doesn't point into the global skills folder is left alone, so a skill you committed to your repo yourself is never at risk.

### CLI transport

The app runs a TCP server bound to loopback and publishes how to reach it in `~/.controlcode/ipc.json`:

```json
{ "port": 45123, "token": "…", "pid": 4242, "protocol": 1 }
```

TCP-on-loopback rather than a Unix socket, so the same code works on Windows without pulling in a named-pipe crate. Since any local process can *connect*, authorisation is separate: the handshake file is readable only by your user, and every request must carry its token or be rejected. Same model local dev servers have used for years.

The `protocol` field guards against a stale CLI: a version mismatch produces a clear message instead of a confusing deserialisation failure.

---

## Configuration

### Where your data lives

Everything is local. Nothing leaves your machine except the HTTP requests needed to fetch skill registries you explicitly added.

```
~/.controlcode/data.db     workspaces, windows, tabs, skills, session history, settings
~/.controlcode/skills/     the single global copy of every installed skill (configurable)
~/.controlcode/ipc.json    CLI handshake — port and token of the running app
```

Inside your projects, Control Code only ever creates symlinks under the skills directory its agent expects (`.claude/skills/`, `.agents/skills/`), and removes them when the workspace closes.

### Settings

| Setting | Default |
|---|---|
| Skills directory | `~/.controlcode/skills/` |
| Theme | Dark (light available) |
| Language | English · Spanish |
| CLI install | Off — enable from Settings → CLI |

---

## Project layout

```
src/
  components/     UI, grouped by feature (tabs, terminal, skills, sessions, marketplace)
  pages/          routed views (home, skills, sessions, marketplace, workspaces, settings)
  store/          Zustand stores, one per domain
  lib/            shared helpers (agent icons, resume commands, pty transfer)
  i18n/           English and Spanish locales
src-tauri/src/
  agents/         PATH detection of known agents + custom TUI definitions
  bin/cli.rs      the `ccode` binary
  database/       SQLite schema, migrations, and all persistence
  ipc/            TCP server, protocol, and CLI installer
  marketplace/    skill registries (GitHub / local), fetching and caching
  session/        session discovery, title generation, markdown export, tmux
  skills/         global install, symlink reconciliation, attach/detach
  terminal/       pty lifecycle
  window/         native window management, tear-off, workspace restore
skills/           the orchestration skill shipped with the app
plan.md           full phased development plan
```

---

## Roadmap

Development follows the phased plan in [`plan.md`](./plan.md).

| Phase | Status |
|---|---|
| 0–2 · Terminals, tabs, persistence | ✅ Done |
| 3 · Hierarchical workspaces | 🚧 Partial — workspace roots and the global workspace terminal are pending |
| 4 · Multi-window tear-off | ✅ Done |
| 5 · Skills manager | ✅ Done |
| 6 · Skills marketplace | 🚧 Mostly — GitHub and local sources ship; generic git and JSON-manifest URLs are pending |
| 7 · Session manager | ✅ Done |
| 8 · Orchestrator CLI | ✅ Done |
| 9 · Orchestrator token budget | ⏳ Planned — compressed output summaries, push events, monitored-tab limits |
| 10 · Quick switcher, snapshots, analytics | ⏳ Planned |
| 11 · MCP server management | ⏳ Planned — install once, attach per workspace or tab |

**Phase 11** brings the install-once-attach-anywhere model to MCP servers, sourced from the [official MCP registry](https://registry.modelcontextprotocol.io/). For agents that accept configuration per invocation — Claude Code via `--mcp-config` / `--strict-mcp-config`, Codex via `CODEX_HOME` — that means genuine per-tab isolation: two tabs on the same folder can see entirely different sets of servers, without touching a single file you own.

---

## Contributing

Issues and pull requests are welcome. Please run `cargo test`, `cargo clippy --all-targets` and `bunx tsc --noEmit` before opening a PR.

## License

MIT © [luis3132](https://github.com/luis3132)
