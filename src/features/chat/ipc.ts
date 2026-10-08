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
  /** `low` … `max`. `null` = el de fábrica de la TUI. */
  effort: string | null;
  permissionMode: PermissionMode;
  /** Una pregunta al margen: corre sobre una copia de la conversación y no la toca. */
  side?: boolean;
  content: Record<string, unknown>[];
  env: Record<string, string>;
  prelaunch: string[];
}

export const chatSend = (turn: ChatTurn) => invoke<void>("chat_send", { turn });
export const chatStop = (tabId: string, side = false) => invoke<boolean>("chat_stop", { tabId, side });
export const chatRunning = (tabId: string) => invoke<boolean>("chat_running", { tabId });

export interface ChatDefaults {
  /** Lo que la TUI usaría si la tab no elige nada. */
  model: string | null;
  effort: string | null;
  /** El interruptor del panel `/effort`. No hay flag en `-p`: la CLI lo lee de su config. */
  ultracode: boolean;
}

/** Con qué arranca la TUI en esta carpeta y con esta cuenta (su `settings.json`). */
export const chatDefaults = (cwd: string, accountId: string | null) =>
  invoke<ChatDefaults>("chat_defaults", { cwd, accountId });

/**
 * Las palabras que la TUI muestra mientras trabaja ("Hyperspacing…"), leídas de su propio
 * binario. Vacío = no se encontraron, y el chat usa su texto de siempre.
 */
export const agentWords = (agentId: string) => invoke<string[]>("agent_words", { agentId });

/** Los niveles de `--effort` que acepta la TUI instalada. Vacío = no habla de esfuerzo. */
export const agentEfforts = (agentId: string) => invoke<string[]>("agent_efforts", { agentId });
/** Los modelos que se conocen: el catálogo de la CLI instalada y los que usaron las
 *  sesiones recientes de esta cuenta (ver `chat/models.rs`). */
export const chatModels = (accountId: string | null) =>
  invoke<{ id: string; name: string | null }[]>("chat_models", { accountId });

/** Con qué modelo y esfuerzo viene corriendo la sesión, según su archivo. */
export const chatSessionSettings = (cwd: string, sessionId: string, accountId: string | null) =>
  invoke<{ model: string | null; effort: string | null }>("chat_session_settings", { cwd, sessionId, accountId });

export const chatTranscript = (cwd: string, sessionId: string, accountId: string | null) =>
  invoke<ChatEvent[]>("chat_transcript", { cwd, sessionId, accountId });

export const onChatEvent = (tabId: string, handler: (e: ChatEnvelope) => void) =>
  listen<ChatEnvelope>(`chat-event-${tabId}`, (e) => handler(e.payload));
