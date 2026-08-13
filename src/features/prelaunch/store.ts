import { create } from "zustand";

import * as ipc from "./ipc";
import type { PrelaunchPreset } from "./types";

interface PrelaunchState {
  presets: PrelaunchPreset[];
  loaded: boolean;

  load: () => Promise<void>;
  save: (draft: { id?: string; name: string; command: string }) => Promise<PrelaunchPreset>;
  remove: (id: string) => Promise<void>;
}

export const usePrelaunchStore = create<PrelaunchState>()((set, get) => ({
  presets: [],
  loaded: false,

  load: async () => {
    set({ presets: await ipc.listPresets(), loaded: true });
  },

  save: async (draft) => {
    const preset = await ipc.savePreset(draft);
    await get().load();
    return preset;
  },

  remove: async (id) => {
    await ipc.deletePreset(id);
    await get().load();
  },
}));
