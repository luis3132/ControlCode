<div align="center">

# Control Code

**An agent development environment.**

Run Claude Code, Codex, OpenCode, Gemini CLI and Kimi Code side by side in real terminals —
with the files, the diffs, git, a browser and a fleet of background agents right next to them.

*Local-first · Open source · Linux · macOS · Windows*

</div>

---

## Why

Coding agents moved the work. Less of the day is typing code and more of it is directing agents, reviewing what they did, unblocking them and trying the result. An IDE is still built around the editor, with the agent squeezed into a side panel. A bare terminal gives you the agent and nothing around it.

Control Code puts the agents in the middle and brings the rest of the environment to them: every folder you work in is a workspace with its agents, its files, its search, its git status, and a browser to try what they built — and point at what's wrong. Hand the long tasks to agents running in the background, each in its own worktree, and answer their permission requests from wherever you are.

Nothing is lost when you close something: workspaces reopen with every agent resuming its own conversation, and every session is archived and searchable.

---

## A tour

### 🖥️ Agents in real terminals, one workspace per folder

Every tab is a genuine pty running the agent of your choice — or just a shell. The left panel lists the folders you're working in, grouped by repository so the worktrees of one project sit together, each with its branch, its uncommitted changes and the agents running in it. The tab bar only shows the active folder's tabs.

The **+** opens a step-by-step wizard for that folder: agent → account → skills, with prelaunch commands under *advanced*. Installed agents are detected from your `PATH`.

**Close a workspace and it's not gone.** It stays in the panel, greyed out; click it and every agent comes back resuming its own conversation, with the same account, prelaunch and skills.

| Agent | Resumes sessions | Skills folder | Several accounts |
|---|---|---|---|
| Claude Code | ✅ | `.claude/skills` | ✅ |
| Codex | ✅ | `.agents/skills` | ✅ |
| OpenCode | ✅ | `.agents/skills` | ✅ |
| Gemini CLI | ✅ | `.agents/skills` | — |
| Kimi Code | ✅ | `.agents/skills` | — |
| Shell | — | — | — |

Anything else you use can be registered as a first-class agent — see *Bring your own tool* below.

### ⌨️ A terminal that behaves like one

- **Kitty keyboard protocol.** TUIs that ask for it can tell Shift+Enter from Enter, Ctrl+I from Tab and Escape from Alt. Accents with dead keys and AltGr characters still type as text, and Tab / Shift+Tab never leave the terminal.
- **Text zoom** from 70 % to 200 %, applied live: the TUI reflows to the new columns without restarting.
- **Sized right from the first byte.** The grid fits its space exactly, and the process is told about a resize only once the size settles — each resize is a full redraw for the TUI.
- **GPU rendering** on the terminal you're looking at, falling back to the DOM renderer for good if the driver loses the context.
- **JetBrains Mono ships with the app**, so the grid looks the same on every machine, and a faint cut line marks each time you send something.
- **Sharp text on Linux.** WebKitGTK's GPU compositing blurs text on many machines; it's off by default, with a switch in Settings.

### 🗂️ Files, search and git beside the agents

The right panel belongs to the active folder:

- **Files** — the tree with git status marks. Files open as tabs next to the agents.
- **Search** — VS Code-style search as you type: case, whole word, regex, include and exclude globs. It respects `.gitignore`, and a click opens the file at that line.
- **Source control** — stage, unstage and discard; commit, or commit everything; switch, create and check out branches; fetch, pull, push (publishing the branch if it has no upstream) and the recent log. It runs your own `git`, so your config, hooks and credentials apply. The remote's provider (GitHub, GitLab, Bitbucket, Azure, Codeberg) is detected for *open on the web*.

### 📝 Files and diffs as tabs

Files open in a CodeMirror editor, in the same tab bar as the agents. Agents write to disk all the time, so the disk is the source of truth: an open file reloads itself while you have no edits, and if you do, you're warned instead of silently overwriting either side. **Ctrl+S only saves if the file hasn't changed since you opened it.**

Changes open as unified diffs, staged (HEAD → index) or unstaged (index → disk), with unchanged regions folded.

### 🌐 A browser to try what they built — and point at what's wrong

Open a browser tab from the tab bar, or click a local URL in any terminal (`Local: http://localhost:5173`) and it opens there, next to the agent that started the server. An empty browser tab offers the dev servers already listening on your machine.

**Mark elements on the page, write a note, send them to an agent.** It receives what it needs to find them in the *code*: the component that rendered them (React, Vue, Svelte), a selector, the identifying attributes and the HTML.

**How it works:** the page is loaded through a local proxy that injects the picker script and passes hot-reload WebSockets through untouched — an iframe from another origin is otherwise a closed box.

### 🚀 A fleet of background agents

**Fleet** (Ctrl+F) runs tasks without a terminal. Give Claude Code a prompt and it works in the background, while each card shows what it's doing live (`Bash(cargo test)`), how long it's been at it, its tokens and its cost — with an optional spend cap. Agents waiting on you are sorted first.

- **One worktree per task.** Two agents editing the same files at once isn't parallel work, it's one undoing the other. A task can run in its own git worktree, on a `cc/<task>` branch; the option turns itself on when another agent is already working in the folder. Worktrees are never discarded on their own: discarding refuses while there are uncommitted changes, and keeps the branch if it has commits.
- **The agent asks, you answer.** Permission requests show the exact command, or the diff of the edit. `y` allows, `n` denies, `r` remembers an exact rule for that folder; rules can be reviewed and edited. Background agents never skip permissions, and a request nobody answers is denied.
- **You hear about it anywhere.** Requests and results reach you on any screen, and the status bar shows what needs you.
- **Take control.** Stop a background task and continue it in a terminal tab — the same conversation, with the same account.

### 🧩 Skills, installed once, attached anywhere

Install a skill once under `~/.controlcode/skills/`. Attach it to a folder or to a single tab from a palette (right-click in the workspaces panel).

**How it works:** Control Code creates **symlinks**, never copies. One canonical copy on disk, referenced from every project that uses it — update it once, every project sees the change.

| | |
|---|---|
| **Scoped** | Attach to a folder and every agent in it gets the skill; attach to a tab and only that one does |
| **Ephemeral** | Links exist only while an agent that wants them is live in that folder, and are reconciled before each agent starts |
| **Per-agent** | `.claude/skills/` for Claude Code, `.agents/skills/` for the agents on the open Agent Skills standard |
| **Non-destructive** | Only symlinks into the global skills directory are managed. A skill folder you committed yourself is never touched |
| **Self-checking** | Broken or stale symlinks are detected when a workspace opens |

The [orchestration skill](#orchestration-skill) ships with the app and installs itself — delete it and it stays deleted.

### 🛒 A marketplace for skills

Add skill repositories and install from them in one click. Paste a plain GitHub link — including a `/tree/branch/subfolder` URL — or point at a local folder. Repos with a `registry.json` manifest are read from it; repos without one are scanned for `SKILL.md` files, with results cached locally. Browse and search from a palette, with each `SKILL.md` rendered.

Ships preconfigured with [autoskills](https://github.com/midudev/autoskills), [anthropics/skills](https://github.com/anthropics/skills) and the [skills.sh](https://skills.sh) directory.

**Two skills can share a name and be nothing alike.** A skill is identified by the repository it came from *plus* the entry inside it, and the author is shown next to the name. Reinstalling updates the copy you already have instead of creating a second one, so whatever you attached it to keeps working.

### ✍️ Write your own skills

Open any installed skill and edit its name and its whole `SKILL.md` right there, or build one from scratch in **Skills → New skill**: a form for the metadata the agent reads, and a full-height editor for the instructions.

Editing a skill that came from a repository never writes over it — saving produces a **local copy**, and the original keeps receiving updates.

### 👥 Several accounts, and what's left of your plan

Run two Claude Code accounts side by side — or two of Codex, or of OpenCode. Each account is its own agent home directory, handed to the process through an environment variable, so tabs never share credentials or history. You log in through the agent's own terminal, inside the app; Control Code never reads, copies or stores a credential.

The status bar shows your accounts. For Claude Code, click one to see **the real usage of your plan** — asked to `claude` itself — and the tokens you've used over time, read from its transcripts.

### 🔧 Prelaunch commands

Some agents need an environment before they're useful: `conda activate ml`, `nvm use`, `source .venv/bin/activate`. Attach a chain of commands to a tab and they run **in the same shell** that becomes the agent — the only place `conda activate` can work at all. Save the ones you repeat as named presets.

### 📜 Every session, archived and searchable

Close a tab and it's archived — along with the skills it had and the tabs that were open beside it.

- **Filter** by agent, folder, date range, skill, or free text, with sessions grouped by repository and worktree
- **Reopen** a session and it comes back with the same skills — or change skills and prelaunch first. If it's already open, you're taken to its tab
- **Get warned first** if a skill is missing — told where to reinstall it from, with the option to install right there or continue without it
- **Export** to markdown: metadata plus the full conversation, read from the agent's own session files
- **Prune** entries from the history without touching the agent's files on disk

### 🤖 A CLI your agent can drive

`ccode` lets any agent orchestrate the app it's running inside. Ask Claude Code to *"open three tabs for this monorepo"* and it does it. Output is always one line of JSON — no scraping, no heuristics. See the [CLI reference](#cli-reference).

An orchestrator's real constraint is its context window, so reading a terminal is designed to be cheap:

| | |
|---|---|
| **Compressed** | `tab output` returns signals, not a transcript: errors and warnings extracted first, progress-bar redraws collapsed, ANSI stripped. `--raw` when you really want the bytes |
| **Incremental** | Each read starts where the last one ended. Calling twice in a row doesn't pay for the same lines twice |
| **Push, not polling** | `watch` a tab and `watch wait` blocks until something actually happens — an error, or the agent going idle |
| **Bounded** | A configurable ceiling on simultaneously watched tabs, and a live estimate in the status bar of what the orchestrator has consumed |

### ⚙️ Bring your own tool

Register any terminal tool as a first-class agent. Beyond a name and a command, you declare how deeply it integrates:

| Field | Enables |
|---|---|
| Resume arguments (`--resume {session}`) | Reopening a specific past session |
| Skills folder (`.agents/skills`) | Control Code managing its skills |
| Sessions folder + id source | Session discovery and readable titles |
| Environment variables | Injected when the process launches |

Everything past name and command is optional. A tool with just those two works fine — it simply opts out of the rest. Several accounts and the fleet are available for the built-in agents that support them.

### ⌨️ Keyboard shortcuts

Shortcuts are captured before the terminal sees them, so they never reach the agent. Pressing a section's shortcut while you're in it takes you back to the terminal.

| Shortcut | Goes to |
|---|---|
| Ctrl+H | Home |
| Ctrl+E | Sessions |
| Ctrl+K | Skills |
| Ctrl+M | Marketplace |
| Ctrl+F | Fleet |
| Ctrl+G | Settings |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab in the folder — files, diffs and browsers included |

---

# Documentation

## Installation

**Requirements:** [Bun](https://bun.sh), a Rust toolchain, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. The skills.sh source also needs Node (it runs `npx skills`).

```bash
git clone https://github.com/luis3132/ControlCode.git
cd ControlCode
bun install
bun run tauri dev
```

### Building a release bundle

```bash
bun run app:build                                   # just the app, this machine, no installers
bun run app:build --release                         # app + `ccode` CLI, packaged for everything this machine can produce
bun run app:build --release --target macos-arm64    # one target only (id or Rust triple)
bun run app:build --list                            # what this machine can and cannot produce, and why
```

No machine can produce every target: the macOS bundle needs Apple's SDK and `codesign`,
and Linux arm64 needs real ARM hardware (the AppImage bundler does not cross-compile).
`--release` packages what it can and says explicitly what it skipped and why.

| Target | Bundles | Where it can be built |
| --- | --- | --- |
| `linux-amd64` | deb, rpm, AppImage | Linux x86_64 |
| `linux-arm64` | deb, rpm, AppImage | Linux arm64 |
| `windows-amd64` | nsis, msi | Windows; cross-compiled from Linux with `cargo-xwin` + NSIS |
| `windows-arm64` | nsis | Windows (either arch); cross-compiled from Linux with `cargo-xwin` + NSIS |
| `macos-arm64` | app, dmg | macOS (either arch) |
| `macos-amd64` | app, dmg | macOS (either arch) |
| `macos-universal` | app, dmg | macOS — Intel + Apple Silicon in one bundle, `--target` only |

`windows-arm64` has no `.msi`: WiX, the tool that builds it, does not support arm64.

> **Why `app:build` and not `tauri build`?** It sets `NO_STRIP=true`. The `strip` bundled with linuxdeploy fails on system libraries that use the modern `.relr.dyn` ELF section, which is standard on current distros. Skipping the strip step is the supported workaround.

### Publishing a release

```bash
bun run release 1.5.3          # sync the version everywhere, commit, tag and push
bun run release 1.5.3 --dry    # show what it would do, touch nothing
```

The tag triggers `.github/workflows/release.yml`: a matrix of six runners, one per OS/arch, builds each target — running the test suites where the runner can — and a final job collects every installer into the GitHub release — refusing duplicate names or files that don't carry the version. Each runner deletes its bundle directory before building and again after uploading, so a cached build can never slip last version's installers into this one. Release notes come from `.github/releases/<tag>.md` when it exists.

### Running the tests

```bash
cd src-tauri && cargo test          # backend suite
cargo clippy --all-targets          # lints
bun run test                        # frontend suite (Vitest)
bunx tsc --noEmit                   # frontend type check
```

Rust tests live in a `test.rs` of their own per module, never mixed into the code they cover; frontend tests live in `tests/` next to the feature and cover the pure logic.

> **Test the release bundle, not just `tauri dev`.** Development builds aren't minified, and release builds are — a bug that only exists in the minified bundle once left every terminal ignoring input. `src/app/tests/buildTarget.test.ts` guards that specific one.

---

## CLI reference

Install `ccode` from **Settings → CLI**: a symlink into `~/.local/bin` on Linux and macOS, a copy under `%LOCALAPPDATA%\ControlCode\bin` on Windows. The `.deb` and `.rpm` packages install it to `/usr/bin` too.

The CLI talks to the running app. All output is a single line of JSON on **stdout**; anything meant for humans (help, usage errors) goes to **stderr**.

### Commands

```
ccode <group> <action> [value] [--flag value ...]
```

The first value can be given positionally, without its flag: `ccode skill install git-helper` is `ccode skill install --skill git-helper`.

#### Tabs

| Command | Description |
|---|---|
| `tab list` | Tabs currently open |
| `tab create <path> --agent <id>` | Open a new tab — see the options below |
| `tab close <id>` | Close a tab |
| `tab output <id> [--lines 40]` | What's *new* since the last read, compressed. `--full` for everything, `--raw` for unprocessed bytes |
| `tab send <id> "..."` | Type into its terminal, then Enter. `--no-enter` to skip |

**Options for `tab create`**

| Flag | Meaning |
|---|---|
| `--skills a,b` | Skills to attach, by name |
| `--account <name>` | Which account of that agent to use — see `accounts` |
| `--pre <command\|preset>` | Runs before the agent, repeatable, executed in the order written |
| `--pre-preset <name>` | Forces the value to be read as a saved preset, not a literal command |
| `--initprompt "..."` | Initial prompt, sent once the agent has finished starting up |
| `--window <label>` | Which window to open it in |

#### Watching tabs

Push mode: the app tells you when something happened, instead of you re-reading terminals.

| Command | Description |
|---|---|
| `watch add <id> [--idle 20]` | Start watching a tab — `--idle` is the seconds of silence that count as "done" |
| `watch remove <id>` | Stop watching it |
| `watch list` | Watched tabs, and the ceiling in effect |
| `watch wait [--timeout 300] [--max 20]` | Block until one of them has news |

#### Windows and saved layouts

Folder workspaces live in the workspaces panel. These commands act on **saved layouts** — named sets of windows and tabs, saved from the app menu and listed in Home.

| Command | Description |
|---|---|
| `window list` | Open windows |
| `window create` | Open a new window |
| `workspace list` | Saved layouts |
| `workspace open --workspace <id\|name>` | Open one. `--close-current` to replace what's open |
| `workspace status` | What's open right now |

#### Skills

| Command | Description |
|---|---|
| `skill list` | Installed, plus what's available in enabled repos |
| `skill search <text>` | Search every repo, skills.sh included |
| `skill install <name\|id>` | Install from the enabled repos |
| `skill show <name\|id>` | Metadata plus the `SKILL.md` itself |
| `skill new <name>` | Create your own skill. `--description`, `--categories a,b`, `--agents a,b`, and `--file <path>` or `--content "..."` |
| `skill edit <name\|id>` | Save new content, from `--file` or `--content`. `--name` to rename, `--copy` to force a copy |

Editing a skill that came from a repository saves a local copy rather than overwriting it, so the original keeps updating. A name that matches more than one installed skill is an error listing the candidates, never a guess.

#### Discovery

| Command | Description |
|---|---|
| `agents` | What to pass to `--agent`, custom TUIs included |
| `accounts` | What to pass to `--account`, per agent |
| `prelaunch` | What to pass to `--pre` |
| `skills` | What to pass to `--skills` |

#### Other

| Command | Description |
|---|---|
| `app status` | App version and state |
| `--json-args '{...}'` | Pass raw arguments as JSON |
| `--version` / `--help` | Version / usage |

`ccode mcp --task <id>` also exists, but it isn't for you: it's the permission server that background agents launch to ask the app before using a tool.

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
- A value starting with `--` can't be parsed positionally — use `--json-args '{"text":"--flag"}'` for those

### Orchestration skill

`skills/controlcode-orchestrator/SKILL.md` documents all of the above for an agent. It ships with the app and installs itself, so Claude Code (or any agent that reads Agent Skills) can drive the app without you explaining the CLI first.

---

## How it works

### Architecture

```
┌──────────────────────────────────────────────────────┐
│  React 19 + TypeScript + Tailwind v4 + Zustand       │
│  xterm.js terminals · CodeMirror · one store/domain  │
└──────────────────────────┬───────────────────────────┘
                           │  Tauri IPC (~120 commands)
┌──────────────────────────┴───────────────────────────┐
│  Rust backend                                        │
│  ├─ terminal/     pty lifecycle, process containment │
│  ├─ runs/         background agents, worktrees,      │
│  │                permission broker and rules        │
│  ├─ explorer/     file tree, search, read and save   │
│  ├─ scm/          git status, commits, branches, sync│
│  ├─ preview/      local proxy for the browser tabs   │
│  ├─ skills/       symlinks, install, authoring       │
│  ├─ marketplace/  registries, fetch + cache          │
│  ├─ session/      discovery, titles, md export       │
│  ├─ agents/       the table of built-in agents,      │
│  │                PATH detection, custom TUIs        │
│  ├─ accounts/     one agent home per account         │
│  ├─ usage/        plan usage and token accounting    │
│  ├─ prelaunch/    command chains before spawn        │
│  ├─ orchestrator/ digest, watch, read cursors        │
│  ├─ window/       native windows, saved layouts      │
│  ├─ database/     SQLite schema + migrations         │
│  └─ ipc/          TCP server for `ccode`, MCP server │
└──────────────────────────────────────────────────────┘
```

Every `mod.rs` is declarative — module declarations and re-exports, no logic — so the file tree is the map of the code.

### Terminals

Each tab owns a pty created through `portable-pty`. The frontend measures the container and passes the real `cols`/`rows` at creation time rather than resizing after the fact — many TUIs read the terminal size once at startup and never redraw correctly after a later `SIGWINCH`. After that the grid follows its container frame by frame, while the pty only hears about the size once it settles.

Output is streamed to the frontend as Tauri events and mirrored into a capped in-memory scrollback buffer, which is what `ccode tab output` reads and what gets persisted with a workspace. Closing a tab kills the agent's whole process tree, not just its leader, so nothing it launched is left running.

### Skill symlinks

Attachment is stored as *intent* ("this skill belongs to this folder / this tab"), not as a fixed path — a folder-scoped skill may map to N tabs, and that set changes as tabs open and close.

The physical symlinks are **derived** from that intent before each agent starts and whenever a tab closes, by reconciling the managed directory against the skills the live tabs actually ask for. Anything in that directory that doesn't point into the global skills folder is left alone, so a skill you committed to your repo yourself is never at risk.

### Background agents

A fleet task runs the agent headless and reads its structured event stream, which becomes the live activity on its card; the raw events are kept per task on disk. Permissions go through a tool the app provides: each task is launched with `ccode mcp` as its permission prompt tool, and with the user's own MCP configuration left out so nothing else can answer for it. `ccode mcp` forwards each request to the app and blocks until someone decides; if the app can't be reached, the answer is no.

### CLI transport

The app runs a TCP server bound to loopback and publishes how to reach it in `~/.controlcode/ipc.json`:

```json
{ "port": 45123, "token": "…", "pid": 4242, "protocol": 1 }
```

TCP-on-loopback rather than a Unix socket, so the same code works on Windows without pulling in a named-pipe crate. Since any local process can *connect*, authorisation is separate: the handshake file is readable only by your user, and every request must carry its token or be rejected.

The `protocol` field guards against a stale CLI: a version mismatch produces a clear message instead of a confusing deserialisation failure.

---

## Configuration

### Where your data lives

Everything is local. Nothing leaves your machine except the requests to skill registries you added, and whatever the agents and your own `git` do.

```
~/.controlcode/data.db       workspaces, tabs, skills, sessions, fleet tasks, permission rules, settings
~/.controlcode/skills/       the single global copy of every installed skill (configurable)
~/.controlcode/worktrees/    one git worktree per fleet task that asked for one
~/.controlcode/runs/         raw event log of each fleet task
~/.controlcode/ipc.json      CLI handshake — port and token of the running app
<app data>/accounts/         one home directory per agent account, written by the agent itself
```

Inside your projects, Control Code only ever creates symlinks under the skills directory its agent expects (`.claude/skills/`, `.agents/skills/`), and removes them when no agent needs them. Per-machine display preferences — terminal zoom, GPU rendering, open file and browser tabs — live in the app's local storage.

### Settings

| Section | What's there |
|---|---|
| Appearance | Theme (dark or light), language (Spanish or English), sharp text on Linux |
| Shortcuts | The list of keyboard shortcuts |
| Terminal | Text zoom, cut lines on each send, GPU rendering |
| Skills directory | Where the global copy lives — `~/.controlcode/skills/` by default |
| TUIs | Your own tools, registered as agents |
| Prelaunch | Saved presets |
| CLI | Install or remove `ccode` |
| Orchestrator | Ceiling of simultaneously watched tabs — 3 by default |

Accounts have a screen of their own, in the activity rail.

---

## Project layout

The frontend is organised by feature, not by file kind: everything a feature needs — its typed IPC layer, its types, its store, its components and its tests — lives in one folder.

```
src/
  app/            the shell: activity rail, panels, tab bar, status bar, shortcuts, window chrome
  shared/         cross-feature UI primitives, keyboard helpers and IPC
  features/
    tabs          agent tabs, the new-agent wizard, file/diff/browser tabs
    terminal      xterm.js, keyboard handling, zoom, rendering
    workspaces    folder workspaces, snapshots, saved layouts
    runs          the fleet: tasks, permissions, rules
    explorer      file tree
    search        text search
    scm           source control panel
    editor        CodeMirror file and diff tabs
    browser       browser tab and element picker
    sessions      history, filters, reopen, export
    skills        attach palette, detail, builder
    marketplace   registries and the skill search palette
    agents        detection, icons, custom TUIs
    accounts      accounts screen and plan usage
    prelaunch     command chains and presets
    orchestrator  watch ceiling and usage indicator
    settings      the settings modal
      ipc.ts      the Tauri commands this feature calls
      types.ts    what crosses the boundary
      store.ts    its Zustand store
      tests/      Vitest, over the pure logic
  i18n/           Spanish and English locales
src-tauri/src/
  app/            startup, signal handling, WebView rendering on Linux
  agents/         the table of built-in agents, PATH detection, custom TUI definitions
  accounts/       several accounts of one agent, isolated by home directory
  usage/          plan usage asked to the agent, token accounting from transcripts
  bin/cli.rs      the `ccode` binary
  database/       connection, schema and migrations, one query module per table
  explorer/       file tree, git marks, text search, reading and saving files
  scm/            source control through your own git
  preview/        the local proxy behind the browser tabs
  ipc/            TCP server, protocol, CLI installer, MCP permission server, dispatcher
  marketplace/    skill registries (GitHub / local / skills.sh), fetching and caching
  orchestrator/   output compression, watch mode, per-reader cursors, usage accounting
  prelaunch/      command chains that run before the agent
  runs/           fleet supervisor, agent adapters, worktrees, permission broker and rules
  session/        session discovery, title generation, markdown export
  skills/         global install, symlink reconciliation, attach/detach, authoring, bundled skill
  terminal/       pty lifecycle and process containment
  util/           running helper processes with timeouts
  window/         native window management and saved layouts
skills/           the orchestration skill shipped with the app
plan.md           the original phased development plan
```

---

## Roadmap

Development started from the phased plan in [`plan.md`](./plan.md), and has since grown past it.

| Phase | Status |
|---|---|
| 0–2 · Terminals, tabs, persistence | ✅ Done |
| 3 · Hierarchical workspaces | 🔄 Redefined — a workspace is a folder, grouped by repository and worktree, that closes and reopens as it was |
| 4 · Multi-window tear-off | ❌ Removed — switching folders in place replaced it; saved multi-window layouts remain |
| 5 · Skills manager | ✅ Done — plus editing, authoring and a bundled skill |
| 6 · Skills marketplace | 🚧 Mostly — GitHub, local folders and skills.sh ship; generic git and JSON-manifest URLs don't |
| 7 · Session manager | ✅ Done |
| 8 · Orchestrator CLI | ✅ Done |
| 9 · Orchestrator token budget | ✅ Done — compression, read cursors, push mode, watch ceiling, usage indicator |
| 10 · Quick switcher, snapshots, analytics | 🚧 Partial — installers for six targets ship; the quick switcher, named snapshots and analytics don't |
| 11 · MCP server management | ⏳ Planned — install once, attach per workspace or tab |
| Beyond the plan | ✅ Fleet, right panel (files, search, git), file/diff/browser tabs, plan usage |

### What's next

**MCP servers.** The install-once-attach-anywhere model of skills, applied to MCP servers from the [official MCP registry](https://registry.modelcontextprotocol.io/). For agents that take configuration per invocation — Claude Code via `--mcp-config` / `--strict-mcp-config`, Codex via `CODEX_HOME` — that means real per-tab isolation: two tabs on the same folder seeing different servers, without touching a file you own. The fleet already launches its tasks this way for its own permission server.

**Signing in to your git host.** The source control panel uses whatever credentials `git` already has. A GitHub / GitLab login is the natural next step, and network operations already go through a single place for it to plug into.

**A bigger fleet.** Background tasks run on Claude Code today; the other agents need their own headless adapters.

**The rest of phase 10.** A quick switcher, named snapshots, and the marketplace's two missing source types.

---

## Contributing

Issues and pull requests are welcome. Please run `cargo test`, `cargo clippy --all-targets`, `bun run test` and `bunx tsc --noEmit` before opening a PR.

## License

MIT © [luis3132](https://github.com/luis3132)
