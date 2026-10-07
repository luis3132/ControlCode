/** El backend del modo HTML. Ver `src-tauri/src/chat/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ChatEnvelope, ChatEvent, PermissionMode } from "./types";

export interface ChatTurn {
  tabId: string;
  cwd: string;
  sessionId: string;
  /** `true` = continuar la sesión; `false` = crearla con ese id. */
  resume: boolean;
  model: string | null;
  permissionMode: PermissionMode;
  content: Record<string, unknown>[];
  env: Record<string, string>;
  prelaunch: string[];
}

export const chatSend = (turn: ChatTurn) => invoke<void>("chat_send", { turn });
export const chatStop = (tabId: string) => invoke<boolean>("chat_stop", { tabId });
export const chatRunning = (tabId: string) => invoke<boolean>("chat_running", { tabId });
export const chatTranscript = (cwd: string, sessionId: string, accountId: string | null) =>
  invoke<ChatEvent[]>("chat_transcript", { cwd, sessionId, accountId });

export const onChatEvent = (tabId: string, handler: (e: ChatEnvelope) => void) =>
  listen<ChatEnvelope>(`chat-event-${tabId}`, (e) => handler(e.payload));
