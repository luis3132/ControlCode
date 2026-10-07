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
 * - `mode`: el modo de permisos.
 * `compact` va como texto: la CLI lo corre con `-p`.
 */
export const BUILTIN_COMMANDS = ["clear", "model", "mode", "compact"] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

/** Los que `claude -p` no tiene y solo existen en la TUI, además de los que avise `init`. */
const TUI_ONLY = new Set([
  "resume", "continue", "exit", "quit", "login", "logout", "config", "theme", "vim", "terminal-setup",
  "ide", "statusline", "permissions", "memory", "doctor", "color", "focus", "help", "status", "export",
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

/** Los alias de `claude --model` (ver `CLAUDE_MODELS` en `agents/registry.rs`). */
export const CLAUDE_MODEL_ALIASES = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "fable", label: "Fable" },
] as const;

/** `claude-haiku-5-5` → `Haiku 5.5`, para mostrar el modelo que reportó el `init`. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
