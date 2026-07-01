import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SkillUsageEntry {
  workspaceId: string;
  workspaceName: string;
  scope: "workspace" | "tab";
  tabId?: string | null;
  tabTitle?: string | null;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string | null;
  version: string;
  categories: string[];
  compatibleAgents: string[];
  compatibleVersions: Record<string, string>;
  author: string | null;
  license: string | null;
  homepage: string | null;
  sourcePath: string;
  installedAt: number;
  updatedAt: number;
  usedBy: SkillUsageEntry[];
}

export interface SymlinkHealthEntry {
  skillName: string;
  tabId: string;
  tabTitle: string | null;
  linkPath: string;
  issue: "missing" | "broken" | "stale_target";
}

/** Metadata editable de un SKILL.md, tal como cruza el límite de Tauri (camelCase). */
export interface SkillFrontmatterInput {
  name: string | null;
  description: string | null;
  version: string | null;
  categories: string[];
  compatibleAgents: string[];
  compatibleVersions: Record<string, string>;
  author: string | null;
  license: string | null;
  homepage: string | null;
}

export interface SkillPreview {
  meta: SkillFrontmatterInput;
  folderName: string;
  /** Campos sugeridos que no vinieron en el frontmatter — completarlos es opcional. */
  missing: string[];
}

interface SkillsState {
  skills: SkillSummary[];
  loading: boolean;
  skillsDir: string;
  brokenSymlinks: SymlinkHealthEntry[];

  loadSkills: () => Promise<void>;
  previewSkill: (sourceFile: string) => Promise<SkillPreview>;
  installSkill: (sourceFile: string, overrides?: SkillFrontmatterInput) => Promise<SkillSummary>;
  getSkillDetail: (id: string) => Promise<SkillSummary & { content: string }>;
  updateSkillContent: (id: string, content: string) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  attachSkill: (skillId: string, workspaceId: string, scope: "workspace" | "tab", tabId?: string) => Promise<void>;
  detachSkill: (skillId: string, workspaceId: string, scope: "workspace" | "tab", tabId?: string) => Promise<void>;
  checkHealth: (workspaceId: string) => Promise<SymlinkHealthEntry[]>;
  loadSkillsDir: () => Promise<void>;
  setSkillsDir: (path: string) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loading: false,
  skillsDir: "",
  brokenSymlinks: [],

  loadSkills: async () => {
    set({ loading: true });
    try {
      const rows = await invoke<SkillSummary[]>("list_skills");
      set({ skills: rows });
    } finally {
      set({ loading: false });
    }
  },

  previewSkill: async (sourceFile) => {
    return invoke<SkillPreview>("preview_skill_metadata", { sourceFile });
  },

  installSkill: async (sourceFile, overrides) => {
    const skill = await invoke<SkillSummary>("install_skill", { sourceFile, overrides: overrides ?? null });
    await get().loadSkills();
    return skill;
  },

  getSkillDetail: async (id) => {
    return invoke("get_skill_detail", { skillId: id });
  },

  updateSkillContent: async (id, content) => {
    await invoke("update_skill_content", { skillId: id, content });
    await get().loadSkills();
  },

  deleteSkill: async (id) => {
    await invoke("delete_skill", { skillId: id });
    await get().loadSkills();
  },

  attachSkill: async (skillId, workspaceId, scope, tabId) => {
    await invoke("attach_skill", { skillId, workspaceId, scope, tabId: tabId ?? null });
    await get().loadSkills();
  },

  detachSkill: async (skillId, workspaceId, scope, tabId) => {
    await invoke("detach_skill", { skillId, workspaceId, scope, tabId: tabId ?? null });
    await get().loadSkills();
  },

  checkHealth: async (workspaceId) => {
    const issues = await invoke<SymlinkHealthEntry[]>("check_symlinks_health", { workspaceId });
    set({ brokenSymlinks: issues });
    return issues;
  },

  loadSkillsDir: async () => {
    const dir = await invoke<string>("get_skills_dir");
    set({ skillsDir: dir });
  },

  setSkillsDir: async (path) => {
    await invoke("set_skills_dir", { path });
    set({ skillsDir: path });
  },
}));
