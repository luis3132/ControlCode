import { create } from "zustand";

interface UiState {
  /** Panel izquierdo (workspaces) plegado: queda solo el riel de iconos. */
  workspacesCollapsed: boolean;
  /** Panel derecho (explorador) plegado: queda su columna de iconos. */
  explorerCollapsed: boolean;
  /** Columna de repositorios del marketplace plegada, para que las skills se lleven
   *  todo el ancho: gestionar repos es algo que se hace de vez en cuando. */
  marketplaceReposCollapsed: boolean;
  settingsOpen: boolean;

  toggleWorkspaces: () => void;
  toggleExplorer: () => void;
  toggleMarketplaceRepos: () => void;
  setSettingsOpen: (open: boolean) => void;
}

const KEY = "cc-ui-panels";

/** Se recuerda entre arranques: que un panel que plegaste vuelva abierto cada vez es de
 *  las cosas que más molestan de una app de trabajo. */
function load(): Pick<UiState, "workspacesCollapsed" | "explorerCollapsed" | "marketplaceReposCollapsed"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return {
        workspacesCollapsed: Boolean(parsed.workspacesCollapsed),
        explorerCollapsed: Boolean(parsed.explorerCollapsed),
        marketplaceReposCollapsed: Boolean(parsed.marketplaceReposCollapsed),
      };
    }
  } catch {
    /* localStorage puede fallar o traer basura; los valores por defecto sirven igual */
  }
  return { workspacesCollapsed: false, explorerCollapsed: false, marketplaceReposCollapsed: false };
}

function persist(state: UiState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      workspacesCollapsed: state.workspacesCollapsed,
      explorerCollapsed: state.explorerCollapsed,
      marketplaceReposCollapsed: state.marketplaceReposCollapsed,
    }));
  } catch {
    /* no poder recordarlo no es motivo para no plegarlo */
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  ...load(),
  settingsOpen: false,

  toggleWorkspaces: () => {
    set({ workspacesCollapsed: !get().workspacesCollapsed });
    persist(get());
  },
  toggleExplorer: () => {
    set({ explorerCollapsed: !get().explorerCollapsed });
    persist(get());
  },
  toggleMarketplaceRepos: () => {
    set({ marketplaceReposCollapsed: !get().marketplaceReposCollapsed });
    persist(get());
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
