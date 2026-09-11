import { create } from "zustand";

import type { PrelaunchStep } from "@/features/prelaunch/types";

import { DEFAULT_WORKSPACE_ID } from "./types";
import type { AgentInfo, Tab } from "./types";

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  detectedAgents: AgentInfo[];
  /** Workspace (layout guardado de ventanas/tabs) al que pertenece ESTA ventana. */
  workspaceId: string;
  hydrated: boolean;

  addTab: (params: {
    cwd: string;
    agent: AgentInfo;
    title?: string;
    titleIsCustom?: boolean;
    ptyId?: number | null;
    sessionId?: string;
    historyId?: string;
    accountId?: string;
    prelaunch?: PrelaunchStep[];
    /** Solo al MOVER una tab entre ventanas: conserva cuándo se abrió de verdad. Es el
     *  piso temporal del descubrimiento de sesión, así que ponerle "ahora" descarta el
     *  transcript de un proceso que puede llevar horas vivo. */
    openedAt?: number;
  }) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setPtyId: (tabId: string, ptyId: number) => void;
  setSessionId: (tabId: string, sessionId: string) => void;
  updateTab: (tabId: string, patch: Partial<Tab>) => void;
  setDetectedAgents: (agents: AgentInfo[]) => void;
  setWorkspaceId: (workspaceId: string) => void;
  hydrateFromBackend: (tabs: Tab[], workspaceId?: string) => void;
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
  workspaceId: DEFAULT_WORKSPACE_ID,
  hydrated: false,

  addTab: ({ cwd, agent, title, titleIsCustom, ptyId, sessionId, historyId, accountId, prelaunch, openedAt }) => {
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
          historyId,
          accountId,
          prelaunch,
          openedAt: openedAt ?? Math.floor(Date.now() / 1000),
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


  setWorkspaceId: (workspaceId) => set({ workspaceId }),

  // Idempotente a propósito: hidratar dos veces tiene que dejar lo mismo que hidratar
  // una. Antes anexaba sin mirar los ids —para el flujo de mover una tab entre ventanas,
  // que ya no existe—, así que cualquier remontaje del árbol de React duplicaba TODAS las
  // tabs: 5 pasaban a 10, a 15. Un error de render en una terminal bastaba para
  // dispararlo en bucle.
  //
  // La regla ahora es fusionar por id: lo que viene del backend manda, y lo que había en
  // memoria y no viene se conserva (una tab recién creada cuya fila todavía no persistió).
  hydrateFromBackend: (tabs, workspaceId) =>
    set((state) => {
      const base = workspaceId ? { workspaceId } : {};
      const incoming = new Set(tabs.map((tab) => tab.id));
      const extras = state.tabs.filter((tab) => !incoming.has(tab.id));
      const merged = [...tabs, ...extras];
      const keepsActive = state.activeTabId !== null
        && merged.some((tab) => tab.id === state.activeTabId);
      return {
        ...base,
        tabs: merged,
        activeTabId: keepsActive ? state.activeTabId : merged[0]?.id ?? null,
      };
    }),

  setHydrated: (hydrated) => set({ hydrated }),
}));
