/** El mensaje que sale (texto, imágenes) y los comandos de `/`. Puro, para poder probarlo. */
import type { Outgoing } from "./types";

/** Los bloques de contenido de la API para un mensaje. */
export function buildContent(msg: Outgoing): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = msg.images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  if (msg.text.trim()) blocks.push({ type: "text", text: msg.text });
  return blocks;
}

/** `/model sonnet` → `{ name: "model", args: "sonnet" }`. `null` si no es un comando. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : null;
}

/**
 * Los comandos que en el chat son un componente y no texto para el agente:
 * - `clear`: empezar otra conversación (la anterior queda en Sesiones).
 * - `model`: el selector de modelo, o cambiarlo directo con `/model sonnet`.
 * - `effort`: cuánto puede pensar (`/effort high`), o el selector.
 * - `mode`: el modo de permisos.
 * - `btw`: una pregunta al margen, sobre una copia de la conversación.
 * `compact` va como texto: la CLI lo corre con `-p`.
 */
export const BUILTIN_COMMANDS = ["clear", "model", "effort", "mode", "btw", "compact"] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

/** Los que `claude -p` no tiene y solo existen en la TUI, además de los que avise `init`. */
const TUI_ONLY = new Set([
  "resume", "continue", "exit", "quit", "login", "logout", "config", "theme", "vim", "terminal-setup",
  "ide", "statusline", "permissions", "memory", "doctor", "color", "focus", "help", "status", "export",
  // Paneles de la TUI: mandarlos como texto le haría contestar al modelo sobre un panel
  // que nadie ve, y encima gastando tokens.
  "usage", "cost", "context", "agents", "hooks", "mcp", "plugin", "plugins", "bashes", "rewind",
  "sessions", "upgrade", "release-notes", "bug", "feedback", "keybindings", "output-style",
  "install-github-app", "privacy-settings", "todos", "add-dir",
]);

export type SlashAction =
  | { kind: "builtin"; name: BuiltinCommand; args: string }
  | { kind: "terminalOnly"; name: string }
  | { kind: "send" };

/** Qué hacer con lo que se escribió. Lo que no es un comando, o es uno del agente (una
 *  skill, `.claude/commands`), se le manda tal cual. */
export function slashAction(text: string, terminalCommands: string[]): SlashAction {
  const cmd = parseSlash(text);
  if (!cmd) return { kind: "send" };
  if ((BUILTIN_COMMANDS as readonly string[]).includes(cmd.name)) {
    return { kind: "builtin", name: cmd.name as BuiltinCommand, args: cmd.args };
  }
  if (TUI_ONLY.has(cmd.name) || terminalCommands.includes(cmd.name)) return { kind: "terminalOnly", name: cmd.name };
  return { kind: "send" };
}

export interface SlashEntry {
  name: string;
  builtin: boolean;
}

/** Lo que muestra el menú de `/` para lo escrito después de la barra: los de la app
 *  primero, después los del agente; los que empiezan así antes que los que solo lo
 *  contienen. */
export function slashMenu(query: string, agentCommands: string[], terminalCommands: string[]): SlashEntry[] {
  const q = query.toLowerCase();
  const builtins = new Set<string>(BUILTIN_COMMANDS);
  const all: SlashEntry[] = [
    ...BUILTIN_COMMANDS.map((name) => ({ name, builtin: true })),
    ...agentCommands
      .filter((name) => !builtins.has(name) && !TUI_ONLY.has(name) && !terminalCommands.includes(name))
      .filter((name) => !name.startsWith("__"))
      .map((name) => ({ name, builtin: false })),
  ];
  const starts = all.filter((e) => e.name.toLowerCase().startsWith(q));
  const contains = all.filter((e) => !e.name.toLowerCase().startsWith(q) && e.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** La consulta del menú de `/`: lo escrito si es una barra y una palabra sin espacios. */
export function slashQuery(draft: string): string | null {
  const m = /^\/([\w:.-]*)$/.exec(draft);
  return m ? m[1]! : null;
}

/** Una mención de archivo como la escribe Claude Code: `@ruta`, entre comillas si tiene
 *  espacios. */
export function mention(path: string, isDir = false): string {
  const p = isDir && !path.endsWith("/") ? `${path}/` : path;
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

export interface ModelChoice {
  /** Lo que recibe `--model`: el nombre completo, así lo que dice el menú es lo que corre. */
  id: string;
  /** "Opus 5.5". */
  label: string;
}

/** Familia y versión de un id (`claude-opus-5-5` → opus, 5, 5). Una fecha al final
 *  (`claude-haiku-4-5-20251001`) no es parte de la versión. */
export function modelVersion(id: string): { family: string; major: number; minor: number } | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (!m) return null;
  return { family: m[1]!, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

/** El orden de las familias en el menú: de la más capaz a la más rápida. Las que no se
 *  conocen van al final, por nombre. */
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

/**
 * Los modelos que ofrece el selector: **el más nuevo de cada familia**, con su versión.
 *
 * Ninguna lista vive acá, porque Anthropic saca modelos y una lista en el código envejece
 * sola. Salen de:
 *
 * 1. **El catálogo de la CLI instalada** (`known`, ver `chat/models.rs`): lo que muestra
 *    su `/model`, con nombre y versión.
 * 2. **Lo que se usó de verdad** (`known` sin nombre, y `seen` de esta carpeta): un alias
 *    puede apuntar a un modelo más nuevo que el del catálogo, y ese es el que corre.
 *
 * Un nombre completo y no un alias, para que "Opus 5.5" en el menú sea Opus 5.5 al correr.
 * Cualquier otro se escribe con `/model <nombre>`.
 */
export function modelChoices(known: { id: string; name: string | null }[], seen: string[]): ModelChoice[] {
  const named = new Map(known.filter((m) => m.name).map((m) => [m.id, m.name!]));
  const best = new Map<string, { id: string; major: number; minor: number }>();
  for (const id of [...known.map((m) => m.id), ...seen]) {
    const v = modelVersion(id);
    if (!v) continue;
    const cur = best.get(v.family);
    const newer = !cur || v.major > cur.major || (v.major === cur.major && v.minor > cur.minor);
    // A igual versión, el que tiene nombre de catálogo (el id corto, sin fecha).
    const same = cur && v.major === cur.major && v.minor === cur.minor && named.has(id) && !named.has(cur.id);
    if (newer || same) best.set(v.family, { id, major: v.major, minor: v.minor });
  }
  const rank = (f: string) => (FAMILY_ORDER.includes(f) ? FAMILY_ORDER.indexOf(f) : FAMILY_ORDER.length);
  return [...best.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, m]) => ({ id: m.id, label: named.get(m.id) ?? modelLabel(m.id) ?? m.id }));
}

/** Cómo se muestra el modelo elegido: un alias (`opus`, de antes o escrito a mano) con la
 *  versión a la que hoy apunta según la lista; un nombre completo, legible. */
export function modelShownAs(model: string, choices: ModelChoice[]): string {
  const exact = choices.find((c) => c.id === model);
  if (exact) return exact.label;
  const family = choices.find((c) => modelVersion(c.id)?.family === model.toLowerCase());
  return family?.label ?? modelLabel(model) ?? model;
}

/** `claude-haiku-5-5` → `Haiku 5.5`, para mostrar el modelo que reportó el `init`. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!m) return model;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
