import { create } from "zustand";

import * as ipc from "./ipc";
import type { CustomAgent, CustomAgentDraft } from "./types";

const LEGACY_KEY = "controlcode-settings";

interface AgentsState {
  customAgents: CustomAgent[];
  loaded: boolean;

  loadCustomAgents: () => Promise<void>;
  saveCustomAgent: (agent: CustomAgentDraft) => Promise<void>;
  removeCustomAgent: (id: string) => Promise<void>;
}

/**
 * Las TUIs custom vivían en `localStorage` (zustand/persist) cuando solo tenían
 * nombre + comando. Ahora las necesita también el backend — la reconciliación de symlinks
 * de skills corre al cerrar una ventana, sin frontend de por medio — así que la fuente de
 * verdad pasó a SQLite. Esto sube lo que hubiera quedado guardado y borra la clave vieja;
 * el import de Rust ignora ids ya presentes, así que correrlo de más no duplica nada.
 */
async function migrateLegacyAgents(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const legacy = parsed?.state?.customAgents;
    if (Array.isArray(legacy) && legacy.length > 0) {
      await ipc.importLegacyCustomAgents(legacy);
    }
  } catch {
    // Un localStorage corrupto no debe impedir que la app arranque: se descarta igual.
  }
  localStorage.removeItem(LEGACY_KEY);
}

export const useAgentsStore = create<AgentsState>()((set, get) => ({
  customAgents: [],
  loaded: false,

  loadCustomAgents: async () => {
    if (!get().loaded) await migrateLegacyAgents();
    const customAgents = await ipc.listCustomAgents();
    set({ customAgents, loaded: true });
  },

  saveCustomAgent: async (agent) => {
    await ipc.upsertCustomAgent(agent);
    await get().loadCustomAgents();
  },

  removeCustomAgent: async (id) => {
    await ipc.deleteCustomAgent(id);
    await get().loadCustomAgents();
  },
}));
