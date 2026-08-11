import { create } from "zustand";
import type { PrelaunchStep } from "./prelaunch";
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

/** Otra tab que estaba abierta en el workspace cuando esta sesión se cerró. */
export interface SiblingTab {
  title: string | null;
  agentLabel: string;
  cwd: string;
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
  siblingTabs: SiblingTab[];
  /** Cuenta de la TUI con la que corría; `null` = la principal (la del sistema). */
  accountId: string | null;
  /** Cadena de pre-lanzamiento con la que se abrió (ver el store `prelaunch`). */
  prelaunch: PrelaunchStep[];
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

  deleteSession: async (historyId, workspaceId) => {
    await invoke("db_delete_session_history", { historyId });
    await get().loadHistory(workspaceId);
  },

  sessionMarkdown: async (historyId) => invoke<string>("session_markdown", { historyId }),

  exportSession: async (historyId, destPath) =>
    invoke("export_session_markdown", { historyId, destPath }),
}));
