import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { SkillSummary } from "./skills";

/** `skillssh` es el directorio abierto de skills.sh, consultado por su CLI (`npx skills`). */
export type RegistrySourceType = "local" | "github" | "skillssh";

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
  /** Instalaciones acumuladas ya formateadas (`"3.3K"`); solo lo informa skills.sh. */
  installs: string | null;
}

/** Payload del evento `cc-registry-progress` (ver `marketplace/mod.rs`). */
export interface RegistryProgress {
  registryId: string;
  phase: "connecting" | "listing" | "scanning" | "saving" | "done" | "error";
  current: number;
  /** `null` mientras la fase no sea contable — la UI muestra spinner en vez de barra. */
  total: number | null;
  detail: string | null;
}

interface MarketplaceState {
  registries: RegistrySummary[];
  skills: MarketplaceSkillEntry[];
  loading: boolean;
  /** Una búsqueda contra un repo remoto en curso (skills.sh). Es lenta y separada de
   *  `loading`, que solo cubre releer lo que ya está en la base. */
  searchingRemote: boolean;
  refreshingId: string | null;
  installingKey: string | null;

  loadRegistries: () => Promise<void>;
  loadSkills: (query?: string, category?: string) => Promise<void>;
  /** Busca en los repos que no se pueden listar de antemano (skills.sh) y refresca la
   *  lista con lo que encuentre. No hace nada si no hay ninguno configurado. */
  searchRemote: (query: string) => Promise<void>;
  /** `id` es opcional pero conviene mandarlo: los eventos de progreso vienen etiquetados
   *  con él, y esta promesa recién resuelve cuando el repo terminó de resolverse. */
  addRegistry: (name: string, sourceType: RegistrySourceType, location: string, id?: string) => Promise<void>;
  renameRegistry: (id: string, name: string) => Promise<void>;
  /** Borra el repo Y sus skills instaladas. Devuelve cuántas skills se llevó. */
  removeRegistry: (id: string) => Promise<number>;
  /** Skills instaladas desde este repo — para listarlas antes de borrarlo. */
  registrySkills: (id: string) => Promise<SkillSummary[]>;
  setRegistryEnabled: (id: string, enabled: boolean) => Promise<void>;
  refreshRegistry: (id: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  installSkill: (registryId: string, skillId: string) => Promise<SkillSummary>;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  registries: [],
  skills: [],
  loading: false,
  searchingRemote: false,
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

  searchRemote: async (query) => {
    const hasRemote = get().registries.some((r) => r.sourceType === "skillssh" && r.enabled);
    if (!hasRemote || query.trim().length < 2) return;
    set({ searchingRemote: true });
    try {
      await invoke("search_remote_registries", { query });
      // El backend deja los resultados en el cache del repo; releerlo es lo que los trae
      // a la grilla. `loadRegistries` además refresca el error del repo (ej. falta Node).
      await get().loadRegistries();
      await get().loadSkills(query);
    } finally {
      set({ searchingRemote: false });
    }
  },

  addRegistry: async (name, sourceType, location, id) => {
    await invoke("add_registry", { id: id ?? null, name, sourceType, location });
    await get().loadRegistries();
    await get().loadSkills();
  },

  renameRegistry: async (id, name) => {
    await invoke("rename_registry", { id, name });
    await get().loadRegistries();
    await get().loadSkills();
  },

  removeRegistry: async (id) => {
    const removedSkills = await invoke<number>("remove_registry", { id });
    await get().loadRegistries();
    await get().loadSkills();
    return removedSkills;
  },

  registrySkills: async (id) => invoke<SkillSummary[]>("registry_skills", { registryId: id }),

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
