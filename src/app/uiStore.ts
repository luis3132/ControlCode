import { create } from "zustand";

import { closePanel, fitPanels, openPanel, type PanelState, type Side } from "@/app/panels";

/** Las secciones del panel derecho. */
export type ExplorerView = "files" | "search" | "scm";

const VIEWS: ExplorerView[] = ["files", "search", "scm"];

interface UiState {
  /** Panel izquierdo (workspaces) plegado: queda solo el riel de iconos. */
  workspacesCollapsed: boolean;
  /** Panel derecho (explorador) plegado: queda su columna de iconos. */
  explorerCollapsed: boolean;
  /** El último panel desplegado y el que plegó la app por falta de lugar (ver `panels`). */
  lastOpened: Side;
  autoCollapsed: Side | null;
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

/** Lo que plegó la app por falta de lugar se guarda como abierto: es lo que la persona
 *  eligió, y en el próximo arranque se vuelve a ajustar al ancho que haya. */
function persist(state: UiState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      workspacesCollapsed: state.workspacesCollapsed && state.autoCollapsed !== "workspaces",
      explorerCollapsed: state.explorerCollapsed && state.autoCollapsed !== "explorer",
      explorerView: state.explorerView,
      marketplaceReposCollapsed: state.marketplaceReposCollapsed,
    }));
  } catch {
    /* no poder recordarlo no es motivo para no plegarlo */
  }
}

const width = () => window.innerWidth;

export const useUiStore = create<UiState>((set, get) => ({
  ...load(),
  lastOpened: "workspaces",
  autoCollapsed: null,
  settingsOpen: false,
  accountsOpen: false,

  toggleWorkspaces: () => {
    const s = get();
    set(s.workspacesCollapsed ? openPanel(s, "workspaces", width()) : closePanel(s, "workspaces"));
    persist(get());
  },
  toggleExplorer: () => {
    const s = get();
    set(s.explorerCollapsed ? openPanel(s, "explorer", width()) : closePanel(s, "explorer"));
    persist(get());
  },
  openExplorer: (explorerView) => {
    const s = get();
    set({ explorerView, ...(s.explorerCollapsed ? openPanel(s, "explorer", width()) : {}) });
    persist(get());
  },
  toggleMarketplaceRepos: () => {
    set({ marketplaceReposCollapsed: !get().marketplaceReposCollapsed });
    persist(get());
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setAccountsOpen: (accountsOpen) => set({ accountsOpen }),
}));

/**
 * Ajusta los paneles al ancho de la ventana ahora y cada vez que cambia. Devuelve cómo
 * soltarlo. Arrancar con la ventana chica y los dos guardados como abiertos también cuenta.
 */
export function initPanelFit(): () => void {
  const fit = () => {
    const patch = fitPanels(useUiStore.getState() as PanelState, window.innerWidth);
    if (Object.keys(patch).length > 0) useUiStore.setState(patch);
  };
  fit();
  window.addEventListener("resize", fit);
  return () => window.removeEventListener("resize", fit);
}
