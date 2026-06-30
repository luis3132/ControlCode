import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "./tabs";

export interface WorkspaceSummary {
  id: string;
  name: string;
  lastActive: number;
  windowCount: number;
  tabCount: number;
}

interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  loading: boolean;
  loadWorkspaces: () => Promise<void>;
  /** Guarda la disposición actual de ventanas (la propia + las que se le pasen) bajo un nombre nuevo. */
  saveCurrentAsWorkspace: (name: string) => Promise<string>;
  /** Abre un workspace guardado; si closeCurrent, cierra primero todas las ventanas abiertas. */
  openWorkspace: (id: string, closeCurrent: boolean) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  /** Falla (con mensaje legible) si el workspace tiene ventanas abiertas o es el de por defecto. */
  deleteWorkspace: (id: string) => Promise<void>;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  loading: false,

  loadWorkspaces: async () => {
    set({ loading: true });
    try {
      const rows = await invoke<WorkspaceSummary[]>("db_list_workspaces");
      set({ workspaces: rows });
    } finally {
      set({ loading: false });
    }
  },

  saveCurrentAsWorkspace: async (name) => {
    const labels = await invoke<string[]>("get_window_labels");
    const ws = await invoke<{ id: string; name: string }>("db_save_workspace", {
      name,
      windowLabels: labels,
    });
    useTabsStore.getState().setWorkspaceId(ws.id);
    await get().loadWorkspaces();
    return ws.id;
  },

  openWorkspace: async (id, closeCurrent) => {
    await invoke("open_workspace", { workspaceId: id, closeCurrent });
    await get().loadWorkspaces();
  },

  renameWorkspace: async (id, name) => {
    await invoke("db_rename_workspace", { workspaceId: id, name });
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (id) => {
    await invoke("db_delete_workspace", { workspaceId: id });
    await get().loadWorkspaces();
  },
}));
