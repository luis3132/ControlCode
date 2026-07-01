# Control Code

A desktop command center for AI coding agents (Claude Code, Gemini CLI, Codex, OpenCode), built with Tauri 2.0. It provides a browser-like UI with tabs, each running its own embedded terminal and agent, on top of a persistent, hierarchical workspace model.

**Status: early development.** The core (embedded terminals, tabs, persistence, windows) is being built out. See [`plan.md`](./plan.md) for the full phased development plan.

## What it does

- **Embedded terminals as tabs** — each tab runs a real pty in a chosen working directory with a chosen agent (Claude Code, Gemini CLI, Codex, OpenCode, or a plain shell).
- **Hierarchical workspaces** — group tabs under a project root, with each tab scoped to its own subfolder so an agent's context doesn't leak into sibling folders.
- **Persistence** — open tabs, their working directories, agents, and order are saved to a local SQLite database and restored on relaunch.
- **Multi-window tab tear-off (implemented)** — drag a tab out to spin it into its own native window, or drop it onto another window's tab bar to merge it there, without killing the underlying pty. Window position/size is persisted and restored on relaunch.
- **Skills manager (planned)** — install a skill once under `~/.controlcode/skills/` and attach it to projects via symlinks instead of copying files.
- **Skills marketplace (planned)** — discover and install skills from GitHub repos, JSON manifests, or local folders.
- **Session manager (planned)** — browse, filter, reopen, and export the history of past agent sessions.
- **Orchestrator CLI (planned)** — a `controlcode` CLI plus a bundled skill so other agents can drive the app (create tabs, read output, manage workspaces) programmatically.

## Stack

- Tauri 2.0 (Rust backend, native multi-window)
- React 19 + TypeScript + Tailwind CSS v4 + Zustand
- xterm.js + portable-pty for embedded terminals
- tmux as the persistence/reattach layer for terminal sessions
- SQLite via rusqlite for local state
- i18next (English / Spanish)

## Getting started

Requirements: [Bun](https://bun.sh), Rust toolchain, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run tauri dev
```

To build a release bundle:

```bash
bun run tauri build
```

## Project layout

```
src/            React frontend (components, pages, stores, i18n)
src-tauri/src/  Rust backend (window management, terminal/pty, session/tmux, database, agent detection)
plan.md         Full phased development plan
```

## License

MIT
