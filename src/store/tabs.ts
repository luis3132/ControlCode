import { create } from "zustand";

export type AgentId = string;

export interface AgentInfo {
  id: AgentId;
  label: string;
  command: string;
  available: boolean;
  version?: string;
  isCustom?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  cwd: string;
  agentId: AgentId;
  command: string;
  ptyId: number | null;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  detectedAgents: AgentInfo[];
  sidebarCollapsed: boolean;

  addTab: (params: { cwd: string; agent: AgentInfo }) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setPtyId: (tabId: string, ptyId: number) => void;
  setDetectedAgents: (agents: AgentInfo[]) => void;
  toggleSidebar: () => void;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  // bash siempre disponible como fallback mientras detect_agents carga
  detectedAgents: [{ id: "bash", label: "Terminal (bash)", command: "bash", available: true }],
  sidebarCollapsed: false,

  addTab: ({ cwd, agent }) => {
    const id = crypto.randomUUID();
    const title =
      agent.id === "bash"
        ? baseName(cwd)
        : `${agent.label} — ${baseName(cwd)}`;
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id, title, cwd, agentId: agent.id, command: agent.command, ptyId: null },
      ],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: (id) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      const next = state.tabs.filter((t) => t.id !== id);
      let nextActive = state.activeTabId;
      if (state.activeTabId === id) {
        nextActive = next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null;
      }
      return { tabs: next, activeTabId: nextActive };
    }),

  activateTab: (id) => set({ activeTabId: id }),

  renameTab: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { tabs };
    }),

  setPtyId: (tabId, ptyId) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ptyId } : t)),
    })),

  setDetectedAgents: (agents) => set({ detectedAgents: agents }),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
