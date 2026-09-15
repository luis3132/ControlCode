import { create } from "zustand";

import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

import {
  activate, agentKey, allGroups, closeGroup, createLayout, findGroup, focusGroup as focusInTree, isAgentKey, keyId,
  moveItem, parseLayout, reconcile, resize, split, viewKey, type SplitSide, type WorkspaceLayout,
} from "./layoutTree";

/**
 * Los grupos de la pantalla dividida, por workspace, y cómo se enganchan con lo que ya había.
 *
 * ## Una sola verdad para "lo que se está mirando"
 *
 * Media app sabe cuál es la tab activa (`activeTabId` en el store de tabs, `activeViewId` en
 * el de vistas): el explorador, la barra de estado, los atajos, la CLI. En vez de enseñarle
 * grupos a todos, esos dos valores pasan a ser la tab visible del GRUPO ENFOCADO. Cuando
 * cualquiera los cambia —abrir un archivo desde el árbol, elegir un agente en el panel
 * izquierdo, `ccode tab create`— el árbol se entera acá: la tab nueva entra al grupo
 * enfocado, y activar una que ya estaba en otro grupo enfoca ese grupo. Cuando el usuario
 * actúa sobre los grupos, `activateItem` mueve esos dos valores. Los demás grupos guardan
 * cuál muestran cada uno.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DropTarget =
  /** Sobre una tira de tabs: entra en `index`. `lineX`/`top`/`height` ubican la marca, en
   *  coordenadas de la ventana. */
  | { kind: "strip"; groupId: string; index: number; lineX: number; top: number; height: number }
  /** Sobre el contenido de un grupo: un borde lo divide, el centro la mueve ahí. `rect` es la
   *  zona que se pinta, en coordenadas de la ventana. */
  | { kind: "zone"; groupId: string; side: SplitSide | "center"; rect: Rect };

export interface TabDrag {
  key: string;
  label: string;
  x: number;
  y: number;
  target: DropTarget | null;
}

interface LayoutState {
  /** Por workspace (su ruta en forma comparable). */
  layouts: Record<string, WorkspaceLayout>;
  /** Dónde está el contenido de cada grupo, relativo al área de tabs. */
  slots: Record<string, Rect>;
  /** La tab que se está arrastrando y dónde caería. */
  drag: TabDrag | null;
}

export const useLayoutStore = create<LayoutState>(() => ({
  layouts: {},
  slots: {},
  drag: null,
}));

export function workspaceOfKey(key: string): string | null {
  if (isAgentKey(key)) {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === keyId(key));
    return tab ? comparablePath(tab.cwd) : null;
  }
  const view = useViewTabsStore.getState().views.find((v) => v.id === keyId(key));
  return view ? comparablePath(view.cwd) : null;
}

export function currentWorkspace(): string | null {
  const { tabs, activeTabId } = useTabsStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  return active ? comparablePath(active.cwd) : null;
}

/** La tab que el resto de la app considera activa, como clave del árbol. */
function globalActiveItem(): string | null {
  const { tabs, activeTabId } = useTabsStore.getState();
  const { views, activeViewId } = useViewTabsStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active) return null;
  const workspace = comparablePath(active.cwd);
  const view = views.find((v) => v.id === activeViewId && comparablePath(v.cwd) === workspace);
  return view ? viewKey(view.id) : agentKey(active.id);
}

export function currentLayout(): WorkspaceLayout | null {
  const workspace = currentWorkspace();
  return workspace ? useLayoutStore.getState().layouts[workspace] ?? null : null;
}

function updateCurrent(fn: (layout: WorkspaceLayout) => WorkspaceLayout): WorkspaceLayout | null {
  const workspace = currentWorkspace();
  const layout = workspace ? useLayoutStore.getState().layouts[workspace] : undefined;
  if (!workspace || !layout) return null;
  const next = fn(layout);
  if (next !== layout) useLayoutStore.setState((s) => ({ layouts: { ...s.layouts, [workspace]: next } }));
  return next;
}

const focusedActive = (layout: WorkspaceLayout) => findGroup(layout, layout.focused)?.active ?? null;

// ── Sincronización con los stores de tabs ────────────────────────────

/** La tab activa que el árbol ya atendió: solo un CAMBIO mueve el foco. Sin esto, enfocar un
 *  grupo vacío duraría hasta que cambiara cualquier cosa de las tabs (un PTY que arranca, un
 *  título) y el foco volvería solo al otro grupo. */
let lastActive: string | null = null;
/** El workspace de la última sincronización; `null` = todavía no hubo ninguna. */
let lastWorkspace: string | null = null;
/** Mientras `activateItem` mueve los dos stores, los estados intermedios no cuentan. */
let batching = false;

const sameLayout = (a: WorkspaceLayout | undefined, b: WorkspaceLayout) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * Pone los árboles al día con las tabs y decide qué tiene el foco. Corre en cada cambio de
 * los dos stores de tabs; `force` activa la tab activa aunque no haya cambiado (volver a
 * una tab después de haber enfocado un grupo vacío).
 */
export function syncLayouts(force = false): void {
  if (batching) return;
  const { tabs, hydrated } = useTabsStore.getState();
  // Antes de que carguen las tabs guardadas no hay con qué comparar: reconciliar ahí sacaría
  // de sus grupos a todos los agentes que todavía no llegaron.
  if (!hydrated) return;
  const { views } = useViewTabsStore.getState();
  const byWorkspace = new Map<string, string[]>();
  const add = (workspace: string, key: string) => byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), key]);
  for (const tab of tabs) add(comparablePath(tab.cwd), agentKey(tab.id));
  for (const view of views) add(comparablePath(view.cwd), viewKey(view.id));

  const workspace = currentWorkspace();
  const active = globalActiveItem();
  const prev = useLayoutStore.getState().layouts;

  // Lo que la app eligió por su cuenta puede no ser lo que corresponde con grupos, y se
  // corrige después de guardar los árboles:
  //
  // - Al cerrar una tab, los stores eligen la siguiente con su propia regla —la vecina en
  //   la lista de toda la ventana, incluso de otra carpeta— y le cambiarían la tab visible
  //   a otro grupo. Si lo que se miraba sigue abierto, se sigue mirando; si fue lo que se
  //   cerró, se pasa a la vecina DENTRO de su grupo.
  // - Al abrir la app, los stores arrancan en el primer agente; el árbol guardado sabe qué
  //   se estaba mirando.
  let restore: string | null = null;
  let keepFocus = false;
  const before = lastWorkspace === null ? (workspace ? prev[workspace] : undefined) : prev[lastWorkspace];
  const beforeWs = lastWorkspace ?? workspace;
  if (before && beforeWs) {
    const alive = byWorkspace.get(beforeWs) ?? [];
    const aliveSet = new Set(alive);
    const removed = allGroups(before.root).some((g) => g.items.some((k) => !aliveSet.has(k)));
    if (alive.length > 0 && (removed || lastWorkspace === null)) {
      const was = focusedActive(before);
      const after = reconcile(before, alive);
      if (was === null && findGroup(after, before.focused)) keepFocus = beforeWs === workspace;
      else {
        const wanted = was && aliveSet.has(was) ? was : focusedActive(after);
        if (wanted && wanted !== active) restore = wanted;
      }
    }
  }
  lastWorkspace = workspace;
  const changedActive = active !== lastActive;
  lastActive = active;

  const next: Record<string, WorkspaceLayout> = {};
  let changed = false;
  for (const [ws, items] of byWorkspace) {
    let layout = reconcile(prev[ws] ?? createLayout(), items);
    const inTree = active !== null && allGroups(layout.root).some((g) => g.items.includes(active));
    if (ws === workspace && active && !restore && !(keepFocus && inTree) && (force || changedActive || !inTree)) {
      layout = activate(layout, active);
    }
    // La misma forma conserva el objeto de antes: los componentes no se vuelven a pintar
    // por un árbol que no cambió.
    next[ws] = sameLayout(prev[ws], layout) ? prev[ws]! : layout;
    if (next[ws] !== prev[ws]) changed = true;
  }
  if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
  if (changed) useLayoutStore.setState({ layouts: next });
  if (restore) activateItem(restore);
}

const KEY = "cc-tab-layouts";

/** Engancha la sincronización y guarda los árboles de esta ventana en `localStorage`. */
export function initLayoutSync(windowLabel: string): () => void {
  const key = `${KEY}:${windowLabel}`;
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const layouts: Record<string, WorkspaceLayout> = {};
    for (const [ws, value] of Object.entries(saved)) {
      const layout = parseLayout(value);
      if (layout) layouts[ws] = layout;
    }
    useLayoutStore.setState({ layouts });
  } catch {
    /* basura en localStorage: se arranca sin dividir, que es lo mismo que la primera vez */
  }
  const sync = () => syncLayouts();
  const unsubTabs = useTabsStore.subscribe(sync);
  const unsubViews = useViewTabsStore.subscribe(sync);
  syncLayouts();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubSave = useLayoutStore.subscribe((state, prev) => {
    if (state.layouts === prev.layouts) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(state.layouts));
      } catch {
        /* no poder recordarlos no impide usarlos */
      }
    }, 300);
  });
  return () => {
    unsubTabs();
    unsubViews();
    unsubSave();
    if (timer) clearTimeout(timer);
  };
}

/** Para los tests: olvida lo que la sincronización recordaba de la vez anterior. */
export function resetLayoutSync(): void {
  lastActive = null;
  lastWorkspace = null;
  batching = false;
  useLayoutStore.setState({ layouts: {}, slots: {}, drag: null });
}

// ── Acciones ─────────────────────────────────────────────────────────

/**
 * Un agente del workspace para dejar como tab activa del store de tabs: sin uno de esa
 * carpeta, una vista de ahí no cuenta como activa. Se prefiere uno que ya se esté viendo en
 * algún grupo, para no cambiarle a nadie lo que muestra.
 */
function anchorFor(workspace: string): string | null {
  const { tabs } = useTabsStore.getState();
  const mine = tabs.filter((t) => comparablePath(t.cwd) === workspace);
  const layout = useLayoutStore.getState().layouts[workspace];
  const visible = layout ? allGroups(layout.root).map((g) => g.active).filter((k): k is string => !!k && isAgentKey(k)) : [];
  return mine.find((t) => visible.includes(agentKey(t.id)))?.id ?? mine[0]?.id ?? null;
}

/** Muestra una tab en su grupo y enfoca ese grupo, moviendo lo que el resto de la app
 *  considera activo. */
export function activateItem(key: string): void {
  const workspace = workspaceOfKey(key);
  if (!workspace) return;
  batching = true;
  try {
    const tabs = useTabsStore.getState();
    const views = useViewTabsStore.getState();
    if (isAgentKey(key)) {
      tabs.activateTab(keyId(key));
      // Si ya era la activa el store no cambia, y la vista de encima seguiría tapándola.
      views.showTerminal();
    } else {
      if (currentWorkspace() !== workspace) {
        const anchor = anchorFor(workspace);
        if (anchor) tabs.activateTab(anchor);
      }
      views.activateView(keyId(key));
    }
  } finally {
    batching = false;
  }
  syncLayouts(true);
}

/** Enfoca un grupo: su tab visible pasa a ser la activa. Uno vacío solo se enfoca. */
export function focusGroup(groupId: string): void {
  const layout = currentLayout();
  const group = layout ? findGroup(layout, groupId) : undefined;
  if (!layout || !group) return;
  if (group.active) {
    if (layout.focused !== groupId || globalActiveItem() !== group.active) activateItem(group.active);
    return;
  }
  updateCurrent((l) => focusInTree(l, groupId));
}

/** Divide un grupo. Con `key`, esa tab se muda al grupo nuevo (ver `split`). */
export function splitGroup(groupId: string, side: SplitSide, key?: string | null): void {
  const layout = updateCurrent((l) => split(l, groupId, side, key ?? undefined));
  const fresh = layout ? focusedActive(layout) : null;
  if (fresh) activateItem(fresh);
}

export function moveItemTo(key: string, groupId: string, index?: number): void {
  updateCurrent((l) => moveItem(l, key, groupId, index));
  activateItem(key);
}

export function closeGroupAt(groupId: string): void {
  const layout = updateCurrent((l) => closeGroup(l, groupId));
  const neighbor = layout ? focusedActive(layout) : null;
  if (neighbor) activateItem(neighbor);
}

export function resizeSplit(splitId: string, sizes: number[]): void {
  updateCurrent((l) => resize(l, splitId, sizes));
}

// ── Lectura para los componentes ─────────────────────────────────────

export function useWorkspaceLayout(): WorkspaceLayout | null {
  const workspace = useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? comparablePath(active.cwd) : null;
  });
  return useLayoutStore((s) => (workspace ? s.layouts[workspace] ?? null : null));
}

/** El lugar de una tab: sobre el hueco de su grupo, o toda el área si no hay división. */
export function placeStyle(rect: Rect | null): { position: "absolute"; left?: number; top?: number; width?: number; height?: number; inset?: number } {
  return rect
    ? { position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { position: "absolute", inset: 0 };
}

export interface Placement {
  groupId: string;
  /** `null` = sin dividir (o todavía sin medir): ocupa toda el área. */
  rect: Rect | null;
}

export interface Placements {
  /** Las tabs que se ven, cada una en el lugar de su grupo. */
  visible: Map<string, Placement>;
  /** La que recibe el teclado. */
  focusedItem: string | null;
}

/** Dónde se dibuja cada tab visible y cuál tiene el foco. Sin árbol (las tabs todavía no
 *  cargaron) se comporta como antes de que existieran los grupos. */
export function usePlacements(): Placements {
  const layout = useWorkspaceLayout();
  const slots = useLayoutStore((s) => s.slots);
  const activeTabId = useTabsStore((s) => (s.tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : null));
  const activeCwd = useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? comparablePath(active.cwd) : null;
  });
  const activeViewId = useViewTabsStore((s) => {
    const view = s.views.find((v) => v.id === s.activeViewId);
    return view && comparablePath(view.cwd) === activeCwd ? view.id : null;
  });

  if (!layout) {
    const focusedItem = activeViewId ? viewKey(activeViewId) : activeTabId ? agentKey(activeTabId) : null;
    const visible = new Map<string, Placement>();
    if (focusedItem) visible.set(focusedItem, { groupId: "", rect: null });
    return { visible, focusedItem };
  }
  const groups = allGroups(layout.root);
  const visible = new Map<string, Placement>();
  for (const group of groups) {
    if (group.active) visible.set(group.active, { groupId: group.id, rect: groups.length > 1 ? slots[group.id] ?? null : null });
  }
  return { visible, focusedItem: focusedActive(layout) };
}
