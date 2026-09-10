import { create } from "zustand";

/** Qué muestra el panel de la izquierda. Por ahora solo workspaces tiene panel propio;
 *  el resto del riel navega a su página. */
export type RailView = "workspaces";

interface UiState {
  /** Panel izquierdo (workspaces) plegado: queda solo el riel de iconos. */
  workspacesCollapsed: boolean;
  /** Panel derecho (explorador) plegado: queda su columna de iconos. */
  explorerCollapsed: boolean;
  settingsOpen: boolean;
  railView: RailView;

  toggleWorkspaces: () => void;
  toggleExplorer: () => void;
  setSettingsOpen: (open: boolean) => void;
}

const KEY = "cc-ui-panels";

/** Se recuerda entre arranques: que un panel que plegaste vuelva abierto cada vez es de
 *  las cosas que más molestan de una app de trabajo. */
function load(): Pick<UiState, "workspacesCollapsed" | "explorerCollapsed"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return {
        workspacesCollapsed: Boolean(parsed.workspacesCollapsed),
        explorerCollapsed: Boolean(parsed.explorerCollapsed),
      };
    }
  } catch {
    /* localStorage puede fallar o traer basura; los valores por defecto sirven igual */
  }
  return { workspacesCollapsed: false, explorerCollapsed: false };
}

function persist(state: UiState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      workspacesCollapsed: state.workspacesCollapsed,
      explorerCollapsed: state.explorerCollapsed,
    }));
  } catch {
    /* no poder recordarlo no es motivo para no plegarlo */
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  ...load(),
  settingsOpen: false,
  railView: "workspaces",

  toggleWorkspaces: () => {
    set({ workspacesCollapsed: !get().workspacesCollapsed });
    persist(get());
  },
  toggleExplorer: () => {
    set({ explorerCollapsed: !get().explorerCollapsed });
    persist(get());
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
