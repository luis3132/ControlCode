/** Comandos de skills. Ver `skills/` en Rust. */
import { invoke } from "@tauri-apps/api/core";

import type {
  SkillFrontmatterInput,
  SkillPreview,
  SkillSummary,
  SymlinkHealthEntry,
} from "./types";

export type SkillScope = "workspace" | "tab";

export const listSkills = () => invoke<SkillSummary[]>("list_skills");

export const previewSkill = (sourceFile: string) =>
  invoke<SkillPreview>("preview_skill_metadata", { sourceFile });

export const installSkill = (sourceFile: string, overrides?: SkillFrontmatterInput) =>
  invoke<SkillSummary>("install_skill", { sourceFile, overrides: overrides ?? null });

/** Lo que manda el constructor: la metadata más el cuerpo del SKILL.md. */
export interface SkillDraft {
  meta: SkillFrontmatterInput;
  /** El markdown de abajo del frontmatter: las instrucciones para el agente. */
  body: string;
}

/** Crea una skill propia, de origen local. */
export const createSkill = (draft: SkillDraft) => invoke<SkillSummary>("create_skill", { draft });

/**
 * Guarda una skill como una COPIA nueva de origen local.
 *
 * Es lo que pasa al editar una que vino de un repositorio: esa copia es un reflejo de lo
 * que el repo publica y se reemplaza entera al reinstalarla, así que guardar encima
 * perdería el trabajo del usuario en la primera actualización.
 *
 * `name` vacío = el nombre de la original con sufijo. `content` vacío = copiar sin editar.
 */
export const forkSkill = (skillId: string, name?: string, content?: string) =>
  invoke<SkillSummary>("fork_skill", {
    skillId,
    name: name ?? null,
    content: content ?? null,
  });

export const skillDetail = (skillId: string) =>
  invoke<SkillSummary & { content: string }>("get_skill_detail", { skillId });

export const updateSkillContent = (skillId: string, content: string) =>
  invoke<void>("update_skill_content", { skillId, content });

export const deleteSkill = (skillId: string) => invoke<void>("delete_skill", { skillId });

export const attachSkill = (
  skillId: string,
  workspaceId: string,
  scope: SkillScope,
  tabId?: string
) => invoke<void>("attach_skill", { skillId, workspaceId, scope, tabId: tabId ?? null });

export const detachSkill = (
  skillId: string,
  workspaceId: string,
  scope: SkillScope,
  tabId?: string
) => invoke<void>("detach_skill", { skillId, workspaceId, scope, tabId: tabId ?? null });

export const checkSymlinksHealth = (workspaceId: string) =>
  invoke<SymlinkHealthEntry[]>("check_symlinks_health", { workspaceId });

/** Hace que la tab nueva herede las skills que su workspace ya tuviera activas. */
export const syncWorkspaceSkills = (workspaceId: string) =>
  invoke<void>("sync_workspace_skills", { workspaceId });

/**
 * Deja la carpeta de skills de la tab con exactamente las suyas. Corre ANTES de spawnear:
 * varios agentes escanean sus skills una sola vez, al boot.
 */
export const reconcileTabSkills = (tabId: string) =>
  invoke<void>("reconcile_tab_skills", { tabId });

export const skillsDir = () => invoke<string>("get_skills_dir");

export const setSkillsDir = (path: string) => invoke<void>("set_skills_dir", { path });
