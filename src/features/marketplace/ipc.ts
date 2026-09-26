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

/**
 * El `SKILL.md` de una entrada del catálogo, para leerla ANTES de instalarla.
 *
 * Falla a propósito en los repos que no pueden servir el archivo sin instalar la skill
 * (skills.sh baja la skill entera para eso): quien llama se queda con la
 * descripción que ya tiene del listado.
 */
export const marketplaceSkillReadme = (registryId: string, skillId: string) =>
  invoke<string>("marketplace_skill_readme", { registryId, skillId });

// ── Diagnóstico de skills.sh (Configuración → skills.sh) ────────────────────

/** Ver `marketplace/skillssh_check.rs`. `search` va por HTTP; el resto es el respaldo con la CLI. */
export type SkillsShStep = "node" | "npx" | "cli" | "search";

export interface SkillsShStepResult {
  step: SkillsShStep;
  /** `warn` = anda, pero algo no está como debería (un Node más viejo que el que pide la CLI). */
  state: "ok" | "warn" | "fail";
  path: string | null;
  version: string | null;
  /** Lo que dijo el programa cuando algo salió mal. */
  output: string | null;
  /** Búsqueda: cuántas skills trajo. */
  results: number | null;
}

export interface NodeInstall {
  minNode: string;
  install: string | null;
  otherInstalls: string[];
  docsUrl: string;
}

/** Un paso. El de Node vuelve a leer el PATH del shell: lo instalado con la app abierta cuenta. */
export const skillsshCheckStep = (step: SkillsShStep) =>
  invoke<SkillsShStepResult>("skillssh_check_step", { step });

export const skillsshNodeInstall = () => invoke<NodeInstall>("skillssh_node_install");
