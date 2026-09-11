import { create } from "zustand";

import * as ipc from "./snapshots";
import type { WorkspaceSnapshot } from "./snapshots";

interface SnapshotsState {
  snapshots: WorkspaceSnapshot[];
  load: () => Promise<void>;
  /** Guarda el recuerdo de una carpeta y lo deja visible en el panel. */
  save: (cwd: string, workspaceId: string, tabs: ipc.SnapshotTab[]) => Promise<void>;
  /** Lo devuelve y lo olvida: reabrir consume el recuerdo. */
  take: (cwd: string) => Promise<WorkspaceSnapshot | null>;
  forget: (cwd: string) => Promise<void>;
}

/**
 * Los workspaces que se cerraron a mano.
 *
 * Vive aparte del store de tabs porque no son tabs: son carpetas SIN agentes vivos que el
 * panel tiene que seguir mostrando. El árbol del panel se arma con las dos cosas.
 */
export const useSnapshotsStore = create<SnapshotsState>((set, get) => ({
  snapshots: [],

  load: async () => set({ snapshots: await ipc.listWorkspaceSnapshots() }),

  save: async (cwd, workspaceId, tabs) => {
    await ipc.saveWorkspaceSnapshot(cwd, workspaceId, tabs);
    await get().load();
  },

  take: async (cwd) => {
    const snapshot = await ipc.takeWorkspaceSnapshot(cwd);
    await get().load();
    return snapshot;
  },

  forget: async (cwd) => {
    await ipc.forgetWorkspaceSnapshot(cwd);
    await get().load();
  },
}));
