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
  /** Vacía el bucket "default" (cierra sus ventanas y borra lo guardado) y abre una
   *  ventana nueva en blanco ahí — "Nuevo workspace" del TopBar. Si el usuario quería
   *  conservar lo anterior debía guardarlo antes con "Guardar workspace". */
  resetDefaultWorkspace: () => Promise<void>;
  /** Guarda bajo un nombre nuevo todas las ventanas abiertas que comparten el workspace
   *  actual de esta ventana (no necesariamente todas las ventanas abiertas en el proceso). */
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

  resetDefaultWorkspace: async () => {
    await invoke("reset_default_workspace");
    await get().loadWorkspaces();
  },

  saveCurrentAsWorkspace: async (name) => {
    const sourceWorkspaceId = useTabsStore.getState().workspaceId;
    const ws = await invoke<{ id: string; name: string }>("db_save_workspace", {
      name,
      sourceWorkspaceId,
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
