import { create } from "zustand";

/** Las secciones del panel derecho. */
export type ExplorerView = "files" | "search" | "scm";

const VIEWS: ExplorerView[] = ["files", "search", "scm"];

interface UiState {
  /** Panel izquierdo (workspaces) plegado: queda solo el riel de iconos. */
  workspacesCollapsed: boolean;
  /** Panel derecho (explorador) plegado: queda su columna de iconos. */
  explorerCollapsed: boolean;
  /** Qué sección del panel derecho se ve. */
  explorerView: ExplorerView;
  /** Columna de repositorios del marketplace plegada, para que las skills se lleven
   *  todo el ancho: gestionar repos es algo que se hace de vez en cuando. */
  marketplaceReposCollapsed: boolean;
  settingsOpen: boolean;
  /** Las cuentas son su propia pantalla, no una sección de Configuración. */
  accountsOpen: boolean;

  toggleWorkspaces: () => void;
  toggleExplorer: () => void;
  /**
   * Muestra ESA sección, desplegando el panel si hacía falta.
   *
   * Antes los iconos del panel plegado solo lo desplegaban, y se abría en la última sección
   * que había quedado: apretar el icono de git mostraba el árbol de archivos. Un icono
   * tiene que llevar a lo que dibuja.
   */
  openExplorer: (view: ExplorerView) => void;
  toggleMarketplaceRepos: () => void;
  setSettingsOpen: (open: boolean) => void;
  setAccountsOpen: (open: boolean) => void;
}

const KEY = "cc-ui-panels";

/** Se recuerda entre arranques: que un panel que plegaste vuelva abierto cada vez es de
 *  las cosas que más molestan de una app de trabajo. */
function load(): Pick<UiState, "workspacesCollapsed" | "explorerCollapsed" | "explorerView" | "marketplaceReposCollapsed"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return {
        workspacesCollapsed: Boolean(parsed.workspacesCollapsed),
        explorerCollapsed: Boolean(parsed.explorerCollapsed),
        explorerView: VIEWS.includes(parsed.explorerView as ExplorerView) ? parsed.explorerView as ExplorerView : "files",
        marketplaceReposCollapsed: Boolean(parsed.marketplaceReposCollapsed),
      };
    }
  } catch {
    /* localStorage puede fallar o traer basura; los valores por defecto sirven igual */
  }
  return { workspacesCollapsed: false, explorerCollapsed: false, explorerView: "files", marketplaceReposCollapsed: false };
}

function persist(state: UiState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      workspacesCollapsed: state.workspacesCollapsed,
      explorerCollapsed: state.explorerCollapsed,
      explorerView: state.explorerView,
      marketplaceReposCollapsed: state.marketplaceReposCollapsed,
    }));
  } catch {
    /* no poder recordarlo no es motivo para no plegarlo */
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  ...load(),
  settingsOpen: false,
  accountsOpen: false,

  toggleWorkspaces: () => {
    set({ workspacesCollapsed: !get().workspacesCollapsed });
    persist(get());
  },
  toggleExplorer: () => {
    set({ explorerCollapsed: !get().explorerCollapsed });
    persist(get());
  },
  openExplorer: (explorerView) => {
    set({ explorerView, explorerCollapsed: false });
    persist(get());
  },
  toggleMarketplaceRepos: () => {
    set({ marketplaceReposCollapsed: !get().marketplaceReposCollapsed });
    persist(get());
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
}));
