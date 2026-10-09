import type { PatchHunk } from "@/shared/lineDiff";

/** Lo que manda el backend del modo HTML. Ver `src-tauri/src/chat/parse.rs`. */
export type ChatEvent =
  | { kind: "init"; sessionId: string | null; model: string | null; permissionMode: string | null;
      slashCommands: string[]; terminalCommands: string[] }
  | { kind: "status"; status: string | null }
  | { kind: "usage"; inputTokens: number | null; outputTokens: number | null }
  | { kind: "textDelta"; text: string; parent: string | null }
  | { kind: "thinkingDelta"; text: string; parent: string | null }
  | { kind: "toolStart"; id: string; name: string; parent: string | null }
  | { kind: "text"; text: string; parent: string | null }
  | { kind: "thinking"; text: string; parent: string | null }
  | { kind: "toolUse"; id: string; name: string; input: Record<string, unknown>; label: string; parent: string | null }
  | { kind: "toolResult"; toolUseId: string; content: string; isError: boolean; images: number;
      truncated: boolean; parent: string | null; patch: PatchHunk[] | null }
  | { kind: "user"; text: string; images: number }
  | { kind: "command"; name: string; args: string }
  | { kind: "commandOutput"; text: string }
  | { kind: "compacted" }
  | { kind: "summary"; text: string }
  | { kind: "result"; ok: boolean; error: string | null; costUsd: number | null; tokensIn: number | null;
      tokensOut: number | null; durationMs: number | null }
  | { kind: "retry"; attempt: number | null; maxRetries: number | null; error: string | null };

/** Lo que llega por `chat-event-<tabId>`. `side` = es de una pregunta al margen (`/btw`),
 *  que corre aparte y no entra en la conversación. */
export type ChatEnvelope =
  | { type: "events"; events: ChatEvent[]; side: boolean }
  | { type: "ended"; code: number | null; stopped: boolean; stderr: string; side: boolean };

export interface ToolResult {
  content: string;
  isError: boolean;
  images: number;
  truncated: boolean;
  /** El diff que hizo la CLI contra el archivo real, cuando la herramienta edita. */
  patch?: PatchHunk[] | null;
}

/** Una cosa dibujada en la conversación. */
export type ChatItem =
  | { kind: "user"; id: number; text: string; images: number }
  | { kind: "text"; id: number; text: string; streaming: boolean }
  | { kind: "thinking"; id: number; text: string; streaming: boolean }
  | { kind: "tool"; id: number; toolUseId: string; name: string; label: string;
      input: Record<string, unknown> | null; result: ToolResult | null;
      /** Lo que hizo el subagente de una `Task`. */
      children: ChatItem[] }
  | { kind: "command"; id: number; name: string; args: string; output: string | null }
  | { kind: "compacted"; id: number; summary: string | null }
  | { kind: "result"; id: number; ok: boolean; error: string | null; costUsd: number | null;
      tokensIn: number | null; tokensOut: number | null; durationMs: number | null }
  | { kind: "notice"; id: number; tone: "info" | "error"; text: string }
  /** Una pregunta al margen (`/btw`): se responde sobre una COPIA de la conversación, así
   *  que la ve entera y no le agrega nada. Se dibuja como su propia tarjeta, acá mismo. */
  | { kind: "side"; id: number; question: string; inner: ChatState; running: boolean };

export interface ChatInfo {
  model: string | null;
  permissionMode: string | null;
  slashCommands: string[];
  terminalCommands: string[];
}

/** Lo que lleva gastado el turno en curso, para mostrarlo mientras trabaja. */
export interface LiveUsage {
  /** El contexto que entró. */
  input: number | null;
  /** Lo que lleva escrito. */
  output: number | null;
}

export interface ChatState {
  items: ChatItem[];
  nextId: number;
  /** "requesting", "compacting", un reintento… `null` = nada que contar. */
  status: string | null;
  /** Lo que va gastando el turno en curso. `null` = todavía no dijo nada. */
  usage: LiveUsage | null;
  info: ChatInfo | null;
}

export const emptyChat = (): ChatState => ({ items: [], nextId: 1, status: null, usage: null, info: null });

/** Una imagen adjunta, lista para la API. */
export interface ImageAttachment {
  name: string;
  mediaType: string;
  /** base64, sin el prefijo `data:`. */
  data: string;
}

/** Un mensaje que espera su turno. */
export interface Outgoing {
  text: string;
  images: ImageAttachment[];
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Cuánto puede pensar el modelo, tal como lo acepta `claude --effort`. `null` = lo que
 *  traiga la TUI de fábrica. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
