# Control Code

A desktop command center for AI coding agents (Claude Code, Gemini CLI, Codex, OpenCode, Kimi Code), built with Tauri 2.0. It gives you a browser-like UI where every tab is a real terminal running an agent, on top of persistent workspaces, centrally managed skills, and a searchable session history.

**Status: active development.** Phases 0–7 of [`plan.md`](./plan.md) are implemented; phase 8 (the orchestrator CLI) is in progress.

## Features

### Terminals and tabs

Each tab runs a real pty in a working directory of your choice, with the agent of your choice — or a plain shell. Installed agents are auto-detected from your `PATH`, and you can register your own (see *Custom TUIs* below).

### Multi-window tear-off

Drag a tab out of the tab bar to spin it into its own native window, or drop it onto another window's tab bar to merge it there. The underlying pty is migrated, not restarted, so the agent never loses its session. Window position, size and monitor are persisted and restored.

### Workspaces

A workspace is a named layout of windows and tabs. Save the arrangement you're working in, reopen it later, and every tab comes back with the same working directory, agent, order and scrollback. Closing and reopening the app restores the workspace you used last.

### Skills manager

Install a skill once under `~/.controlcode/skills/` and attach it wherever you need it — Control Code creates symlinks instead of copying files.

- **Scoped to what's open.** A skill attached to a workspace reaches every tab in it; attached to a tab, only that one. Skills are materialised on disk only while their window is open, so opening a different workspace in the same folder never leaks the previous one's skills.
- **Per-agent conventions.** Symlinks land in `.claude/skills/` for Claude Code and `.agents/skills/` for the agents that adopted the open Agent Skills standard.
- **Non-destructive.** Only symlinks pointing into the global skills directory are managed. A skill folder you committed to the repo yourself is never touched.
- **Health check.** Broken or stale symlinks are detected when a workspace opens.

### Skills marketplace

Add skill repositories and install from them with one click. Sources can be a GitHub repo — pasted as a plain link, including a `/tree/branch/subfolder` URL — or a local folder. Repos with a `registry.json` manifest are read from it; repos without one are scanned automatically for `SKILL.md` files. Ships preconfigured with [autoskills](https://github.com/midudev/autoskills) and [anthropics/skills](https://github.com/anthropics/skills).

### Session manager

Every tab you close is archived, with the skills it had active and the other tabs that were open beside it.

- Filter by agent, folder, date range, skill, or free text
- Grouped by subfolder, most recently active first
- Reopen a session and it comes back with the same skills reattached
- If a skill is missing, you're warned **before** reopening, told where to reinstall it from, and can install it right there or continue without it
- Export any session to markdown — metadata plus the full conversation, read from the agent's own session files
- Remove entries from the history without touching the agent's files on disk

### Custom TUIs

Register any terminal tool as a first-class agent. Beyond name and command, you can declare how it integrates:

| Field | Enables |
|---|---|
| Resume arguments (`--resume {session}`) | reopening a specific past session |
| Skills folder (`.agents/skills`) | Control Code managing its skills |
| Sessions folder + id source | session discovery and readable titles |
| Environment variables | injected when the process launches |

Everything past name and command is optional — a tool with just those two still works, it simply opts out of those features.

## Stack

- Tauri 2.0 (Rust backend, native multi-window)
- React 19 + TypeScript + Tailwind CSS v4 + Zustand
- xterm.js + portable-pty for embedded terminals
- SQLite via rusqlite for local state
- reqwest for skill registries
- i18next (English / Spanish)

## Getting started

Requirements: [Bun](https://bun.sh), a Rust toolchain, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run tauri dev
```

Build a release bundle:

```bash
bun run tauri build
```

Run the backend test suite:

```bash
cd src-tauri && cargo test
```

## Where your data lives

Everything is local. Nothing is sent anywhere except the HTTP requests needed to fetch skill registries you explicitly add.

```
~/.controlcode/data.db     workspaces, windows, tabs, skills, session history, settings
~/.controlcode/skills/     the single global copy of every installed skill (configurable)
```

Inside your projects, Control Code only ever creates symlinks under the skills directory its agent expects (`.claude/skills/`, `.agents/skills/`), and removes them when the workspace closes.

## Project layout

```
src/
  components/     UI, grouped by feature (tabs, terminal, skills, sessions, marketplace)
  pages/          routed views (home, skills, sessions, marketplace, workspaces, settings)
  store/          Zustand stores, one per domain
  lib/            small shared helpers (agent icons, resume commands, pty transfer)
  i18n/           English and Spanish locales
src-tauri/src/
  agents/         PATH detection of known agents + custom TUI definitions
  database/       SQLite schema, migrations, and all persistence
  marketplace/    skill registries (GitHub / local), fetching and caching
  session/        session discovery, title generation, markdown export, tmux
  skills/         global install, symlink reconciliation, attach/detach
  terminal/       pty lifecycle
  window/         native window management, tear-off, workspace restore
plan.md           full phased development plan
```

## License

MIT
