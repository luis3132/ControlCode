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
  titleIsCustom?: boolean;
  cwd: string;
  agentId: AgentId;
  agentLabel: string;
  command: string;
  ptyId: number | null;
  sessionId?: string;
  scrollback?: string;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  detectedAgents: AgentInfo[];
  sidebarCollapsed: boolean;
  workspaceRoot: string | null;
  hydrated: boolean;

  addTab: (params: {
    cwd: string;
    agent: AgentInfo;
    title?: string;
    titleIsCustom?: boolean;
    ptyId?: number | null;
    sessionId?: string;
  }) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setPtyId: (tabId: string, ptyId: number) => void;
  setSessionId: (tabId: string, sessionId: string) => void;
  updateTab: (tabId: string, patch: Partial<Tab>) => void;
  setDetectedAgents: (agents: AgentInfo[]) => void;
  toggleSidebar: () => void;
  setWorkspaceRoot: (root: string | null) => void;
  hydrateFromBackend: (tabs: Tab[]) => void;
  setHydrated: (hydrated: boolean) => void;
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
  workspaceRoot: null,
  hydrated: false,

  addTab: ({ cwd, agent, title, titleIsCustom, ptyId, sessionId }) => {
    const id = crypto.randomUUID();
    const computedTitle =
      title ??
      (agent.id === "bash" ? baseName(cwd) : `${agent.label} — ${baseName(cwd)}`);
    set((state) => ({
      tabs: [
        ...state.tabs,
        {
          id,
          title: computedTitle,
          titleIsCustom,
          cwd,
          agentId: agent.id,
          agentLabel: agent.label,
          command: agent.command,
          ptyId: ptyId ?? null,
          sessionId,
        },
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
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, title, titleIsCustom: true } : t)),
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

  setSessionId: (tabId, sessionId) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
    })),

  updateTab: (tabId, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    })),

  setDetectedAgents: (agents) => set({ detectedAgents: agents }),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setWorkspaceRoot: (root) => set({ workspaceRoot: root }),

  hydrateFromBackend: (tabs) =>
    set((state) => {
      if (state.tabs.length === 0) {
        return { tabs, activeTabId: tabs[0]?.id ?? null };
      }
      // Ya hay tabs en memoria (flujo cc-detach/cc-receive-tab) — anexar sin pisarlas.
      return { tabs: [...tabs, ...state.tabs] };
    }),

  setHydrated: (hydrated) => set({ hydrated }),
}));
