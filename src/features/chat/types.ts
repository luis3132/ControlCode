/** Lo que manda el backend del modo HTML. Ver `src-tauri/src/chat/parse.rs`. */
export type ChatEvent =
  | { kind: "init"; sessionId: string | null; model: string | null; permissionMode: string | null;
      slashCommands: string[]; terminalCommands: string[] }
  | { kind: "status"; status: string | null }
  | { kind: "textDelta"; text: string; parent: string | null }
  | { kind: "thinkingDelta"; text: string; parent: string | null }
  | { kind: "toolStart"; id: string; name: string; parent: string | null }
  | { kind: "text"; text: string; parent: string | null }
  | { kind: "thinking"; text: string; parent: string | null }
  | { kind: "toolUse"; id: string; name: string; input: Record<string, unknown>; label: string; parent: string | null }
  | { kind: "toolResult"; toolUseId: string; content: string; isError: boolean; images: number;
      truncated: boolean; parent: string | null }
  | { kind: "user"; text: string; images: number }
  | { kind: "command"; name: string; args: string }
  | { kind: "commandOutput"; text: string }
  | { kind: "compacted" }
  | { kind: "summary"; text: string }
  | { kind: "result"; ok: boolean; error: string | null; costUsd: number | null; tokensIn: number | null;
      tokensOut: number | null; durationMs: number | null }
  | { kind: "retry"; attempt: number | null; maxRetries: number | null; error: string | null };

/** Lo que llega por `chat-event-<tabId>`. */
export type ChatEnvelope =
  | { type: "events"; events: ChatEvent[] }
  | { type: "ended"; code: number | null; stopped: boolean; stderr: string };

export interface ToolResult {
  content: string;
  isError: boolean;
  images: number;
  truncated: boolean;
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
  | { kind: "notice"; id: number; tone: "info" | "error"; text: string };

export interface ChatInfo {
  model: string | null;
  permissionMode: string | null;
  slashCommands: string[];
  terminalCommands: string[];
}

export interface ChatState {
  items: ChatItem[];
  nextId: number;
  /** "requesting", "compacting", un reintento… `null` = nada que contar. */
  status: string | null;
  info: ChatInfo | null;
}

export const emptyChat = (): ChatState => ({ items: [], nextId: 1, status: null, info: null });

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
