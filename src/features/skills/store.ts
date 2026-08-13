import { create } from "zustand";
import * as ipc from "./ipc";
import type {
  SkillFrontmatterInput,
  SkillPreview,
  SkillSummary,
  SymlinkHealthEntry,
} from "./types";

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
      const rows = await ipc.listSkills();
      set({ skills: rows });
    } finally {
      set({ loading: false });
    }
  },

  previewSkill: async (sourceFile) => {
    return ipc.previewSkill(sourceFile);
  },

  installSkill: async (sourceFile, overrides) => {
    const skill = await ipc.installSkill(sourceFile, overrides);
    await get().loadSkills();
    return skill;
  },

  getSkillDetail: async (id) => {
    return ipc.skillDetail(id);
  },

  updateSkillContent: async (id, content) => {
    await ipc.updateSkillContent(id, content);
    await get().loadSkills();
  },

  deleteSkill: async (id) => {
    await ipc.deleteSkill(id);
    await get().loadSkills();
  },

  attachSkill: async (skillId, workspaceId, scope, tabId) => {
    await ipc.attachSkill(skillId, workspaceId, scope, tabId);
    await get().loadSkills();
  },

  detachSkill: async (skillId, workspaceId, scope, tabId) => {
    await ipc.detachSkill(skillId, workspaceId, scope, tabId);
    await get().loadSkills();
  },

  checkHealth: async (workspaceId) => {
    const issues = await ipc.checkSymlinksHealth(workspaceId);
    set({ brokenSymlinks: issues });
    return issues;
  },

  loadSkillsDir: async () => {
    const dir = await ipc.skillsDir();
    set({ skillsDir: dir });
  },

  setSkillsDir: async (path) => {
    await ipc.setSkillsDir(path);
    set({ skillsDir: path });
  },
}));
