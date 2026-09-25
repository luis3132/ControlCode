import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { exitAllWithSave } from "@/app/closeWithSave";

import { updateCheck, updateInstall } from "./ipc";
import type { UpdateInfo, UpdateProgress } from "./types";

const SKIP_KEY = "cc-update-skip";

function skipped(): string | null {
  try { return localStorage.getItem(SKIP_KEY); } catch { return null; }
}

type Phase = "idle" | "checking" | "installing" | "installed" | "error";

interface UpdatesState {
  info: UpdateInfo | null;
  phase: Phase;
  progress: UpdateProgress | null;
  error: string | null;
  /** El aviso está a la vista. Se abre solo con una versión nueva no omitida. */
  open: boolean;
  check: (opts?: { manual?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  skip: () => void;
  dismiss: () => void;
}

export const useUpdatesStore = create<UpdatesState>()((set, get) => ({
  info: null,
  phase: "idle",
  progress: null,
  error: null,
  open: false,

  check: async ({ manual = false } = {}) => {
    if (get().phase === "installing" || get().phase === "installed") return;
    set({ phase: "checking", error: null });
    try {
      const info = await updateCheck();
      // Una versión que el usuario eligió omitir no vuelve a abrirse sola; pedida a mano sí.
      const show = info.newer && (manual || skipped() !== info.latest);
      set({ info, phase: "idle", open: show || get().open });
    } catch (e) {
      set({ phase: manual ? "error" : "idle", error: manual ? String(e) : null });
    }
  },

  install: async () => {
    set({ phase: "installing", progress: { downloaded: 0, total: null }, error: null });
    const off = await listen<UpdateProgress>("cc-update-progress", (e) => set({ progress: e.payload }));
    try {
      await updateInstall();
      set({ phase: "installed" });
    } catch (e) {
      set({ phase: "error", error: String(e) });
    } finally {
      off();
    }
  },

  // Guarda todo (terminales, navegador…) como al cerrar, y arranca la versión nueva.
  restart: () => exitAllWithSave("restart"),

  skip: () => {
    const latest = get().info?.latest;
    if (latest) { try { localStorage.setItem(SKIP_KEY, latest); } catch { /* sin storage: vuelve a avisar */ } }
    set({ open: false });
  },

  dismiss: () => set({ open: false }),
}));
