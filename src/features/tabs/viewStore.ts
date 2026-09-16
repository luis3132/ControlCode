import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import {
  baseName, findExisting, nextActiveAfterClose, toPersisted,
  type BrowserView, type DiffView, type FileView, type ViewOwner, type ViewTab,
} from "@/features/tabs/viewTabs";
import { isMarkdownPath, prefersMarkdownPreview } from "@/features/editor/markdown";

interface ViewTabsState {
  views: ViewTab[];
  /** `null` = se ve la terminal del agente activo. */
  activeViewId: string | null;
  /** Tabs que se montan aunque nadie las haya mirado: un navegador que maneja un agente
   *  tiene que tener su página cargada aunque el usuario siga en la terminal. */
  keepMountedIds: string[];

  openFile: (cwd: string, path: string, reveal?: { line: number; column: number }) => void;
  openDiff: (cwd: string, root: string, path: string, staged: boolean) => void;
  /** Devuelve el id de la tab. `activate: false` la abre sin sacar al usuario de lo que mira;
   *  `owner` la marca como manejada por un agente. */
  openBrowser: (cwd: string, url?: string, opts?: { activate?: boolean; owner?: ViewOwner }) => string;
  keepMounted: (id: string) => void;
  activateView: (id: string) => void;
  /** Volver a la terminal. */
  showTerminal: () => void;
  closeView: (id: string) => void;
  updateView: (id: string, patch: Partial<Omit<FileView, "kind" | "id">> | Partial<Omit<BrowserView, "kind" | "id">>) => void;
  hydrate: (views: ViewTab[]) => void;
}

export const useViewTabsStore = create<ViewTabsState>((set, get) => ({
  views: [],
  activeViewId: null,
  keepMountedIds: [],

  openFile: (cwd, path, reveal) => {
    const wanted = { kind: "file", cwd, path } as const;
    const existing = findExisting(get().views, wanted);
    const nextReveal = reveal ? { ...reveal, nonce: Date.now() } : undefined;
    if (existing) {
      set((s) => ({
        activeViewId: existing.id,
        views: nextReveal
          ? s.views.map((v) => (v.id === existing.id && v.kind === "file" ? { ...v, reveal: nextReveal, preview: false } : v))
          : s.views,
      }));
      return;
    }
    // Un salto a una línea (desde el buscador) es para ver el código, no el documento.
    const preview = isMarkdownPath(path) && !nextReveal ? prefersMarkdownPreview() : undefined;
    const view: FileView = { ...wanted, id: crypto.randomUUID(), title: baseName(path), reveal: nextReveal, preview };
    set((s) => ({ views: [...s.views, view], activeViewId: view.id }));
  },

  openDiff: (cwd, root, path, staged) => {
    const wanted = { kind: "diff", cwd, root, path, staged } as const;
    const existing = findExisting(get().views, wanted);
    if (existing) {
      set({ activeViewId: existing.id });
      return;
    }
    const view: DiffView = { ...wanted, id: crypto.randomUUID(), title: baseName(path) };
    set((s) => ({ views: [...s.views, view], activeViewId: view.id }));
  },

  openBrowser: (cwd, url = "", opts) => {
    const view: BrowserView = { kind: "browser", cwd, url, id: crypto.randomUUID(), title: "", owner: opts?.owner };
    const activate = opts?.activate ?? true;
    set((s) => ({
      views: [...s.views, view],
      activeViewId: activate ? view.id : s.activeViewId,
      keepMountedIds: activate ? s.keepMountedIds : [...s.keepMountedIds, view.id],
    }));
    return view.id;
  },

  keepMounted: (id) =>
    set((s) => (s.keepMountedIds.includes(id) ? s : { keepMountedIds: [...s.keepMountedIds, id] })),

  activateView: (id) => set({ activeViewId: id }),
  showTerminal: () => set({ activeViewId: null }),

  closeView: (id) =>
    set((s) => ({
      activeViewId: nextActiveAfterClose(s.views, id, s.activeViewId),
      views: s.views.filter((v) => v.id !== id),
      keepMountedIds: s.keepMountedIds.filter((k) => k !== id),
    })),

  updateView: (id, patch) =>
    set((s) => ({ views: s.views.map((v) => (v.id === id ? ({ ...v, ...patch } as ViewTab) : v)) })),

  hydrate: (views) => set({ views, activeViewId: null }),
}));

// Elegir un agente —desde la barra, el panel izquierdo, un atajo o la CLI— es querer ver
// su terminal. Se engancha acá una sola vez en vez de repetirlo en cada lugar que activa
// una tab: alcanza con que cambie la tab activa.
useTabsStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId && useViewTabsStore.getState().activeViewId !== null) {
    useViewTabsStore.getState().showTerminal();
  }
});

const KEY = "cc-view-tabs";

/**
 * Restaura las tabs de archivo/navegador de esta ventana y las guarda cuando cambian.
 *
 * En `localStorage` y no en la base: no son estado del trabajo sino del escritorio —
 * reabrirlas es cómodo, perderlas no rompe nada—, y así no hace falta tocar el esquema
 * que comparten las tabs de agentes.
 */
export function initViewTabsPersistence(windowLabel: string): () => void {
  const key = `${KEY}:${windowLabel}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) useViewTabsStore.getState().hydrate(JSON.parse(raw) as ViewTab[]);
  } catch {
    /* basura en localStorage: se arranca sin tabs, que es lo mismo que la primera vez */
  }
  return useViewTabsStore.subscribe((state, prev) => {
    if (state.views === prev.views) return;
    try {
      localStorage.setItem(key, JSON.stringify(toPersisted(state.views)));
    } catch {
      /* no poder recordarlas no impide usarlas */
    }
  });
}
