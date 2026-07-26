import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/** Skill tal como estaba activa en la tab al cerrarla (se congela en el historial). */
export interface ArchivedSkill {
  id: string;
  name: string;
  scope: "tab" | "workspace";
}

/** Dónde volver a bajar una skill que ya no está instalada. */
export interface SkillSource {
  registryId: string;
  registryName: string;
  marketplaceSkillId: string;
}

/** Estado actual de una de las skills que tenía una sesión archivada. */
export interface SessionSkillStatus {
  name: string;
  scope: "tab" | "workspace";
  /** `null` = ya no está instalada. */
  installedSkillId: string | null;
  /** Presente solo si falta Y algún repo habilitado la ofrece. */
  availableFrom: SkillSource | null;
}

export interface SessionHistoryEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  title: string | null;
  sessionId: string | null;
  skills: ArchivedSkill[];
  openedAt: number;
  closedAt: number;
}

interface SessionsState {
  history: SessionHistoryEntry[];
  loading: boolean;
  loadHistory: (workspaceId: string) => Promise<void>;
  /** Para cada skill archivada: si sigue instalada y, si no, de dónde bajarla. */
  checkSessionSkills: (historyId: string) => Promise<SessionSkillStatus[]>;
  /** Reattachea a la tab las que sí están; devuelve los nombres de las que faltan. */
  restoreSessionSkills: (historyId: string, workspaceId: string, tabId: string) => Promise<string[]>;
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

  checkSessionSkills: async (historyId) =>
    invoke<SessionSkillStatus[]>("check_session_skills", { historyId }),

  restoreSessionSkills: async (historyId, workspaceId, tabId) =>
    invoke<string[]>("restore_session_skills", { historyId, workspaceId, tabId }),
}));
