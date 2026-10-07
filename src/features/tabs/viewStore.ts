import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import {
  baseName, findExisting, nextActiveAfterClose, toPersisted, transientToReplace,
  type BrowserView, type DiffView, type FileView, type ViewOwner, type ViewTab,
} from "@/features/tabs/viewTabs";
import { isMarkdownPath, prefersMarkdownPreview } from "@/features/editor/markdown";
import { isInside, remapPath } from "@/features/explorer/paths";

interface ViewTabsState {
  views: ViewTab[];
  /** `null` = se ve la terminal del agente activo. */
  activeViewId: string | null;
  /** Tabs que se montan aunque nadie las haya mirado: un navegador que maneja un agente
   *  tiene que tener su página cargada aunque el usuario siga en la terminal. */
  keepMountedIds: string[];

  /** `transient`: se abre como provisoria (ver `ViewBase.transient`); sin eso, fija. */
  openFile: (cwd: string, path: string, reveal?: { line: number; column: number }, opts?: OpenOptions) => void;
  /** Con `commit`, el diff de ese commit contra su padre. */
  openDiff: (cwd: string, root: string, path: string, staged: boolean, commit?: { hash: string; short: string; origPath?: string | null }, opts?: OpenOptions) => void;
  /** Deja fija una tab provisoria. */
  pinView: (id: string) => void;
  /** Devuelve el id de la tab. `activate: false` la abre sin sacar al usuario de lo que mira;
   *  `owner` la marca como manejada por un agente. */
  openBrowser: (cwd: string, url?: string, opts?: { activate?: boolean; owner?: ViewOwner }) => string;
  keepMounted: (id: string) => void;
  activateView: (id: string) => void;
  /** Volver a la terminal. */
  showTerminal: () => void;
  closeView: (id: string) => void;
  updateView: (id: string, patch: Partial<Omit<FileView, "kind" | "id">> | Partial<Omit<BrowserView, "kind" | "id">>) => void;
  /** Un archivo o carpeta cambió de lugar: las tabs de lo que estaba ahí lo siguen. */
  retargetPath: (from: string, to: string) => void;
  /** Se borró: se cierran las tabs de lo que había ahí, salvo las que tienen cambios sin
   *  guardar — esos cambios solo existen en la tab. */
  closePath: (path: string) => void;
  hydrate: (views: ViewTab[]) => void;
}

interface OpenOptions {
  transient?: boolean;
}

/**
 * Lo que hace el árbol de grupos cuando una tab provisoria se reemplaza por otra: poner la
 * nueva en el lugar de la vieja. Lo instala `layoutStore` (que importa este store, así que
 * no puede ir al revés). Corre ANTES de cambiar las vistas: si no, la sincronización vería
 * desaparecer la vieja y aparecer la nueva, y la mandaría al final de la barra.
 */
let replacer: ((fromId: string, toId: string, cwd: string) => void) | null = null;
export function setViewReplacer(fn: typeof replacer) {
  replacer = fn;
}

export const useViewTabsStore = create<ViewTabsState>((set, get) => {
  /** Agrega `view`. Si es provisoria y ya hay otra en su workspace, toma su lugar. */
  const addView = (view: ViewTab) => {
    const old = view.transient ? transientToReplace(get().views, view.cwd) : undefined;
    if (!old) {
      set((s) => ({ views: [...s.views, view], activeViewId: view.id }));
      return;
    }
    replacer?.(old.id, view.id, view.cwd);
    set((s) => ({
      views: s.views.map((v) => (v.id === old.id ? view : v)),
      activeViewId: view.id,
      keepMountedIds: s.keepMountedIds.filter((k) => k !== old.id),
    }));
  };

  return {
    views: [],
    activeViewId: null,
    keepMountedIds: [],

    openFile: (cwd, path, reveal, opts) => {
      const wanted = { kind: "file", cwd, path } as const;
      const existing = findExisting(get().views, wanted);
      const nextReveal = reveal ? { ...reveal, nonce: Date.now() } : undefined;
      // Abrirla fija (doble click, o desde un lugar que no abre provisorias) fija la que ya estaba.
      const pin = !opts?.transient;
      if (existing) {
        set((s) => ({
          activeViewId: existing.id,
          views: nextReveal || (pin && existing.transient)
            ? s.views.map((v) => {
              if (v.id !== existing.id || v.kind !== "file") return v;
              return { ...v, ...(nextReveal ? { reveal: nextReveal, preview: false } : {}), ...(pin ? { transient: false } : {}) };
            })
            : s.views,
        }));
        return;
      }
      // Un salto a una línea (desde el buscador) es para ver el código, no el documento.
      const preview = isMarkdownPath(path) && !nextReveal ? prefersMarkdownPreview() : undefined;
      addView({
        ...wanted, id: crypto.randomUUID(), title: baseName(path), reveal: nextReveal, preview,
        ...(opts?.transient ? { transient: true } : {}),
      });
    },

    openDiff: (cwd, root, path, staged, commit, opts) => {
      const wanted = {
        kind: "diff", cwd, root, path, staged,
        ...(commit ? { commit: commit.hash, origPath: commit.origPath ?? undefined } : {}),
      } as const;
      const existing = findExisting(get().views, wanted);
      if (existing) {
        set((s) => ({
          activeViewId: existing.id,
          views: !opts?.transient && existing.transient
            ? s.views.map((v) => (v.id === existing.id ? { ...v, transient: false } : v))
            : s.views,
        }));
        return;
      }
      // El commit en el título: el mismo archivo puede estar abierto en varios commits.
      const title = commit ? `${baseName(path)} @ ${commit.short}` : baseName(path);
      const view: DiffView = { ...wanted, id: crypto.randomUUID(), title, ...(opts?.transient ? { transient: true } : {}) };
      addView(view);
    },

    pinView: (id) =>
      set((s) => ({ views: s.views.map((v) => (v.id === id && v.transient ? { ...v, transient: false } : v)) })),

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

    retargetPath: (from, to) =>
      set((s) => ({
        views: s.views.map((v) => {
          if (v.kind !== "file") return v;
          const path = remapPath(v.path, from, to);
          return path === null ? v : { ...v, path, title: baseName(path) };
        }),
      })),

    closePath: (path) => {
      for (const v of get().views) {
        if (v.kind === "file" && !v.dirty && isInside(v.path, path)) get().closeView(v.id);
      }
    },

    hydrate: (views) => set({ views, activeViewId: null }),
  };
});

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
