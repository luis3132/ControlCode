import { create } from "zustand";

import * as ipc from "./ipc";
import { applyPrefs, collectPrefs } from "./prefs";
import type { SyncReport, SyncStatus } from "./types";

interface SyncState {
  status: SyncStatus | null;
  running: boolean;
  error: string | null;
  /** Lo que devolvió la última sincronización de esta sesión. */
  report: SyncReport | null;
  /** Cómo cambiar el tema: lo registra quien tiene el `ThemeProvider` a mano. */
  setTheme: (theme: "light" | "dark") => void;
  load: () => Promise<void>;
  sync: () => Promise<void>;
  setup: (accountId: string, name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setAuto: (auto: boolean) => Promise<void>;
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  status: null,
  running: false,
  error: null,
  report: null,
  setTheme: () => {},

  load: async () => set({ status: await ipc.syncStatus() }),

  sync: async () => {
    if (get().running) return;
    set({ running: true, error: null });
    try {
      const result = await ipc.syncNow(collectPrefs());
      applyPrefs(result.prefs, get().setTheme);
      set({ report: result.report });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ running: false });
      get().load().catch(() => {});
    }
  },

  setup: async (accountId, name) => {
    set({ running: true, error: null });
    try {
      set({ status: await ipc.syncSetup(accountId, name) });
    } catch (e) {
      set({ error: String(e), running: false });
      return;
    }
    set({ running: false });
    // Recién conectado: la primera sincronización trae lo que haya y sube lo de acá.
    await get().sync();
  },

  disconnect: async () => {
    await ipc.syncDisconnect();
    set({ report: null, error: null });
    await get().load();
  },

  setAuto: async (auto) => {
    await ipc.syncSetAuto(auto);
    await get().load();
  },
}));
