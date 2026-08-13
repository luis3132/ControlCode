import { create } from "zustand";
import { AlertaToast } from "neogestify-ui-components";
import { useTabsStore } from "@/features/tabs/store";
import { useSkillsStore } from "@/features/skills/store";
import { broadcastEvent, focusWindow } from "@/shared/ipc/window";

import * as ipc from "./ipc";
import type { WorkspaceSummary } from "./types";

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
  /** Si el workspace ya tiene ventanas nativas vivas, las enfoca (en vez de abrir otro
   *  juego de ventanas duplicado) y devuelve `true` — el llamador no debe mostrar el
   *  diálogo de "cerrar actuales/mantener". Si devuelve `false`, el workspace no está
   *  abierto en ningún lado y el flujo normal (mostrar el diálogo) debe seguir. */
  focusIfOpen: (id: string) => Promise<boolean>;
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
      const rows = await ipc.listWorkspaces();
      set({ workspaces: rows });
    } finally {
      set({ loading: false });
    }
  },

  resetDefaultWorkspace: async () => {
    await ipc.resetDefaultWorkspace();
    await get().loadWorkspaces();
  },

  saveCurrentAsWorkspace: async (name) => {
    const sourceWorkspaceId = useTabsStore.getState().workspaceId;
    const ws = await ipc.saveWorkspace(name, sourceWorkspaceId);
    useTabsStore.getState().setWorkspaceId(ws.id);

    // `db_save_workspace` mueve en la DB TODAS las ventanas abiertas del workspace de
    // origen, no solo esta — pero el store en memoria de esas otras ventanas sigue
    // diciendo el id viejo. Quedaban creyendo que están en `default` mientras su fila ya
    // vive en el workspace nuevo: su autosave bumpeaba el `last_active` del workspace
    // equivocado (y con eso la app podía reabrir el workspace que no era), y "Nuevo
    // workspace" desde una de ellas apuntaba a un bucket que ya no las contiene.
    await broadcastEvent(
      "cc-workspace-reassigned",
      JSON.stringify({ from: sourceWorkspaceId, to: ws.id })
    ).catch(console.error);

    await get().loadWorkspaces();
    return ws.id;
  },

  openWorkspace: async (id, closeCurrent) => {
    await ipc.openWorkspace(id, closeCurrent);
    await get().loadWorkspaces();
    // Best-effort: no bloquea la apertura del workspace si el check falla.
    useSkillsStore.getState().checkHealth(id).then((issues) => {
      if (issues.length > 0) {
        AlertaToast("Skills", `${issues.length} skill symlink(s) need attention`, "warning", 6000);
      }
    }).catch(() => {});
  },

  focusIfOpen: async (id) => {
    const liveWindows = await ipc.openWindowsOf(id).catch(() => []);
    if (liveWindows.length === 0) return false;
    await focusWindow(liveWindows[0].label).catch(console.error);
    return true;
  },

  renameWorkspace: async (id, name) => {
    await ipc.renameWorkspace(id, name);
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (id) => {
    await ipc.deleteWorkspace(id);
    await get().loadWorkspaces();
  },
}));
