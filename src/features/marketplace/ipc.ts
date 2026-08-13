/** Comandos del marketplace. Ver `marketplace/registries.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { SkillSummary } from "@/features/skills/types";

import type { MarketplaceSkillEntry, RegistrySourceType, RegistrySummary } from "./types";

export const listRegistries = () => invoke<RegistrySummary[]>("list_registries");

export const listMarketplaceSkills = (query?: string, category?: string) =>
  invoke<MarketplaceSkillEntry[]>("list_marketplace_skills", {
    query: query || null,
    category: category || null,
  });

/**
 * `id` es opcional pero conviene mandarlo: los eventos de progreso vienen etiquetados con
 * él, y esta promesa recién resuelve cuando el repo terminó de resolverse.
 */
export const addRegistry = (
  name: string,
  sourceType: RegistrySourceType,
  location: string,
  id?: string
) => invoke<void>("add_registry", { id: id ?? null, name, sourceType, location });

export const renameRegistry = (id: string, name: string) =>
  invoke<void>("rename_registry", { id, name });

/** Borra el repo Y sus skills instaladas. Devuelve cuántas skills se llevó. */
export const removeRegistry = (id: string) => invoke<number>("remove_registry", { id });

export const setRegistryEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_registry_enabled", { id, enabled });

export const refreshRegistry = (id: string) => invoke<void>("refresh_registry", { id });

/** Skills instaladas desde este repo — para listarlas antes de borrarlo. */
export const registrySkills = (registryId: string) =>
  invoke<SkillSummary[]>("registry_skills", { registryId });

/** Busca en los repos que no se pueden listar de antemano (skills.sh). */
export const searchRemoteRegistries = (query: string) =>
  invoke<void>("search_remote_registries", { query });

export const installMarketplaceSkill = (registryId: string, skillId: string) =>
  invoke<SkillSummary>("install_marketplace_skill", { registryId, skillId });

/** Valida una ubicación mientras el usuario tipea, sin llegar a crear el repo. */
export const previewRegistryLocation = (sourceType: RegistrySourceType, location: string) =>
  invoke<string>("preview_registry_location", { sourceType, location });
