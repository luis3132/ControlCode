/** Comandos del historial de sesiones. Ver `database/queries/sessions.rs` y `session/`. */
import { invoke } from "@tauri-apps/api/core";

import type { SessionHistoryEntry, SessionSkillStatus } from "./types";

export const listHistory = (workspaceId: string) =>
  invoke<SessionHistoryEntry[]>("db_list_session_history", { workspaceId });

export const deleteHistoryEntry = (historyId: string) =>
  invoke<void>("db_delete_session_history", { historyId });

/** Para cada skill archivada: si sigue instalada y, si no, de dónde bajarla. */
export const checkSessionSkills = (historyId: string) =>
  invoke<SessionSkillStatus[]>("check_session_skills", { historyId });

/** Reattachea a la tab las que sí están; devuelve los nombres de las que faltan. */
export const restoreSessionSkills = (historyId: string, workspaceId: string, tabId: string) =>
  invoke<string[]>("restore_session_skills", { historyId, workspaceId, tabId });

export const sessionMarkdown = (historyId: string) =>
  invoke<string>("session_markdown", { historyId });

export const exportSessionMarkdown = (historyId: string, destPath: string) =>
  invoke<void>("export_session_markdown", { historyId, destPath });

/** Título legible derivado de la sesión real del agente. Ver `session/title.rs`. */
export const sessionTitle = (args: {
  agentId: string;
  cwd: string;
  sessionId: string | null;
  fallback: string;
  accountId: string | null;
}) => invoke<{ title: string; source: "summary" | "first_message" | "fallback" }>(
  "get_session_title",
  args
);

/**
 * Busca en disco la sesión que la tab está usando. `startedAfter` es el piso temporal
 * (epoch en segundos): sin él, el archivo más nuevo podría ser de otra tab.
 */
export const discoverSessionId = (args: {
  agentId: string;
  cwd: string;
  startedAfter: number;
  accountId: string | null;
}) => invoke<string | null>("discover_session_id", args);

/** Dónde está abierta ya esta conversación, si lo está. */
export interface OpenTabLocation {
  windowLabel: string;
  tabId: string;
}

/**
 * Busca la conversación entre las tabs vivas del workspace. "Reabrir" la enfoca en vez de
 * duplicarla — por `sessionId` cuando se resolvió, y si no por la entrada del historial.
 */
export const findOpenTabForSession = (args: {
  sessionId: string | null;
  historyId: string | null;
  workspaceId: string;
}) => invoke<OpenTabLocation | null>("find_open_tab_for_session", args);
