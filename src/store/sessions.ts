import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SessionHistoryEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  title: string | null;
  sessionId: string | null;
  skills: string[];
  openedAt: number;
  closedAt: number;
}

interface SessionsState {
  history: SessionHistoryEntry[];
  loading: boolean;
  loadHistory: (workspaceId: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  history: [],
  loading: false,

  loadHistory: async (workspaceId) => {
    set({ loading: true });
    try {
      const rows = await invoke<SessionHistoryEntry[]>("db_list_session_history", { workspaceId });
      set({ history: rows });
    } finally {
      set({ loading: false });
    }
  },
}));
