import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { SkillSummary } from "./skills";

export type RegistrySourceType = "local" | "github";

export interface RegistrySummary {
  id: string;
  name: string;
  sourceType: RegistrySourceType;
  location: string;
  priority: number;
  enabled: boolean;
  lastFetched: number | null;
  skillCount: number;
  error: string | null;
}

export interface MarketplaceSkillEntry {
  id: string;
  registryId: string;
  registryName: string;
  name: string;
  description: string | null;
  categories: string[];
  compatibleAgents: string[];
  folderPath: string;
  files: string[];
}

interface MarketplaceState {
  registries: RegistrySummary[];
  skills: MarketplaceSkillEntry[];
  loading: boolean;
  refreshingId: string | null;
  installingKey: string | null;

  loadRegistries: () => Promise<void>;
  loadSkills: (query?: string, category?: string) => Promise<void>;
  addRegistry: (name: string, sourceType: RegistrySourceType, location: string) => Promise<void>;
  removeRegistry: (id: string) => Promise<void>;
  setRegistryEnabled: (id: string, enabled: boolean) => Promise<void>;
  refreshRegistry: (id: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  installSkill: (registryId: string, skillId: string) => Promise<SkillSummary>;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  registries: [],
  skills: [],
  loading: false,
  refreshingId: null,
  installingKey: null,

  loadRegistries: async () => {
    const registries = await invoke<RegistrySummary[]>("list_registries");
    set({ registries });
  },

  loadSkills: async (query, category) => {
    set({ loading: true });
    try {
      const skills = await invoke<MarketplaceSkillEntry[]>("list_marketplace_skills", {
        query: query || null,
        category: category || null,
      });
      set({ skills });
    } finally {
      set({ loading: false });
    }
  },

  addRegistry: async (name, sourceType, location) => {
    await invoke("add_registry", { name, sourceType, location });
    await get().loadRegistries();
    await get().loadSkills();
  },

  removeRegistry: async (id) => {
    await invoke("remove_registry", { id });
    await get().loadRegistries();
    await get().loadSkills();
  },

  setRegistryEnabled: async (id, enabled) => {
    await invoke("set_registry_enabled", { id, enabled });
    await get().loadRegistries();
    await get().loadSkills();
  },

  refreshRegistry: async (id) => {
    set({ refreshingId: id });
    try {
      await invoke("refresh_registry", { id });
      await get().loadRegistries();
      await get().loadSkills();
    } finally {
      set({ refreshingId: null });
    }
  },

  refreshAll: async () => {
    const { registries } = get();
    for (const r of registries) {
      // Secuencial a propósito: son requests a APIs públicas externas (rate limit anónimo
      // de GitHub incluido) — en paralelo, refrescar varios repos a la vez multiplica el
      // riesgo de pegarle a ese límite en una sola pasada.
      await get().refreshRegistry(r.id);
    }
  },

  installSkill: async (registryId, skillId) => {
    const key = `${registryId}:${skillId}`;
    set({ installingKey: key });
    try {
      return await invoke<SkillSummary>("install_marketplace_skill", { registryId, skillId });
    } finally {
      set({ installingKey: null });
    }
  },
}));
