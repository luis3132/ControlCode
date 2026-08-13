import { create } from "zustand";
import * as ipc from "./ipc";
import type { SessionHistoryEntry, SessionSkillStatus } from "./types";

interface SessionsState {
  history: SessionHistoryEntry[];
  loading: boolean;
  loadHistory: (workspaceId: string) => Promise<void>;
  /** Para cada skill archivada: si sigue instalada y, si no, de dónde bajarla. */
  checkSessionSkills: (historyId: string) => Promise<SessionSkillStatus[]>;
  /** Reattachea a la tab las que sí están; devuelve los nombres de las que faltan. */
  restoreSessionSkills: (historyId: string, workspaceId: string, tabId: string) => Promise<string[]>;
  /** Saca la sesión del historial. No borra el archivo de sesión del agente en disco. */
  deleteSession: (historyId: string, workspaceId: string) => Promise<void>;
  /** Markdown de la sesión (metadata + conversación), para previsualizar. */
  sessionMarkdown: (historyId: string) => Promise<string>;
  exportSession: (historyId: string, destPath: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  history: [],
  loading: false,

  loadHistory: async (workspaceId) => {
    set({ loading: true });
    try {
      const rows = await ipc.listHistory(workspaceId);
      set({ history: rows });
    } finally {
      set({ loading: false });
    }
  },

  checkSessionSkills: async (historyId) =>
    ipc.checkSessionSkills(historyId),

  restoreSessionSkills: async (historyId, workspaceId, tabId) =>
    ipc.restoreSessionSkills(historyId, workspaceId, tabId),

  deleteSession: async (historyId, workspaceId) => {
    await ipc.deleteHistoryEntry(historyId);
    await get().loadHistory(workspaceId);
  },

  sessionMarkdown: async (historyId) => ipc.sessionMarkdown(historyId),

  exportSession: async (historyId, destPath) =>
    ipc.exportSessionMarkdown(historyId, destPath),
}));
