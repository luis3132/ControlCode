import { create } from "zustand";

import { deleteCanvasPage, loadCanvasPages, saveCanvasPage } from "./ipc";
import { applyOps, pageData, parsePage, type ApplyResult, type CanvasOp, type CanvasPage } from "./model";

/**
 * El canvas de cada workspace de esta ventana: sus páginas, cuál se está mirando, si el
 * workspace está en modo canvas, y quién tocó qué hace un momento.
 *
 * Las páginas son de la carpeta, no de la ventana: se guardan en la base (una fila por
 * página) y se cargan la primera vez que se miran. Lo que es de la ventana —el modo y la
 * página activa— va en `localStorage`, como el árbol de grupos.
 *
 * Todo cambio pasa por `dispatchCanvas` (ver `model.ts`): la UI y los agentes por el mismo
 * camino.
 */

/** Quién hizo un cambio. `null` = el usuario. */
export interface CanvasActor {
  id: string;
  label: string;
}

export interface Presence extends CanvasActor {
  at: number;
}

/** Un pedido de mover la vista (centrar un nodo, ver todo), que atiende el canvas montado. */
export interface ViewRequest {
  workspace: string;
  page: string;
  focus?: string;
  fit?: boolean;
  zoom?: number;
  nonce: number;
}

interface CanvasState {
  /** Por workspace (ruta comparable), en orden. Solo los ya cargados. */
  pages: Record<string, CanvasPage[]>;
  loaded: Record<string, boolean>;
  /** Los workspaces que esta ventana muestra como canvas. */
  canvasMode: Record<string, boolean>;
  activePage: Record<string, string>;
  /** Lo que tocó un agente hace poco: por id de nodo del canvas, o `<ruta>#<id>` para lo de
   *  un diagrama. */
  presence: Record<string, Presence>;
  /** El nodo que recibe el teclado, como clave de placements (`a:<tab>` / `v:<vista>`). */
  focusedItem: string | null;
  viewRequest: ViewRequest | null;
}

export const useCanvasStore = create<CanvasState>(() => ({
  pages: {},
  loaded: {},
  canvasMode: {},
  activePage: {},
  presence: {},
  focusedItem: null,
  viewRequest: null,
}));

/** Cuánto dura pintado lo que tocó un agente. */
export const PRESENCE_MS = 8000;

// ── Carga y guardado ─────────────────────────────────────────────────

const loading = new Map<string, Promise<void>>();

/** Carga las páginas de un workspace si todavía no se cargaron. */
export function ensureLoaded(workspace: string): Promise<void> {
  if (useCanvasStore.getState().loaded[workspace]) return Promise.resolve();
  const pending = loading.get(workspace);
  if (pending) return pending;
  const promise = loadCanvasPages(workspace)
    .then((rows) => {
      // Lo que se haya creado mientras se cargaba (no debería, pero) gana sobre lo leído.
      const current = useCanvasStore.getState().pages[workspace] ?? [];
      const fromDb = rows.map((r) => parsePage(r.id, r.name, r.data)).filter((p) => !current.some((c) => c.id === p.id));
      useCanvasStore.setState((s) => ({
        pages: { ...s.pages, [workspace]: [...fromDb, ...current] },
        loaded: { ...s.loaded, [workspace]: true },
      }));
    })
    .catch((e) => {
      console.error("No se pudo cargar el canvas", e);
      // Sin base no se puede guardar, pero el canvas se puede usar igual en esta corrida.
      useCanvasStore.setState((s) => ({ loaded: { ...s.loaded, [workspace]: true } }));
    })
    .finally(() => loading.delete(workspace));
  loading.set(workspace, promise);
  return promise;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(workspace: string, page: CanvasPage) {
  const prev = saveTimers.get(page.id);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    page.id,
    setTimeout(() => {
      saveTimers.delete(page.id);
      // Lo último que haya, no lo que había al programarlo.
      const pages = useCanvasStore.getState().pages[workspace] ?? [];
      const index = pages.findIndex((p) => p.id === page.id);
      if (index < 0) return;
      const latest = pages[index]!;
      saveCanvasPage({ id: latest.id, workspace, name: latest.name, position: index, data: pageData(latest) }).catch(console.error);
    }, 400)
  );
}

function persistDiff(workspace: string, before: CanvasPage[], after: CanvasPage[]) {
  after.forEach((page, index) => {
    const prevIndex = before.findIndex((p) => p.id === page.id);
    if (prevIndex !== index || before[prevIndex] !== page) scheduleSave(workspace, page);
  });
  for (const page of before) {
    if (after.some((p) => p.id === page.id)) continue;
    const timer = saveTimers.get(page.id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(page.id);
    deleteCanvasPage(page.id).catch(console.error);
  }
}

// ── Cambios ─────────────────────────────────────────────────────────

let presenceTimer: ReturnType<typeof setTimeout> | null = null;

function prunePresence() {
  const now = Date.now();
  const presence = useCanvasStore.getState().presence;
  const alive = Object.fromEntries(Object.entries(presence).filter(([, p]) => now - p.at < PRESENCE_MS));
  if (Object.keys(alive).length !== Object.keys(presence).length) useCanvasStore.setState({ presence: alive });
  presenceTimer = Object.keys(alive).length > 0 ? setTimeout(prunePresence, 1000) : null;
}

/** Pinta esas claves del color de `actor` por un rato (ver `PRESENCE_MS`). */
export function markPresence(keys: string[], actor: CanvasActor) {
  if (keys.length === 0) return;
  const at = Date.now();
  useCanvasStore.setState((s) => ({ presence: { ...s.presence, ...Object.fromEntries(keys.map((k) => [k, { ...actor, at }])) } }));
  if (!presenceTimer) presenceTimer = setTimeout(prunePresence, 1000);
}

/**
 * Aplica operaciones al canvas de un workspace. Tira el error de la que falle sin aplicar
 * ninguna. Con `actor`, lo que tocó queda pintado de su color un rato.
 */
export function dispatchCanvas(workspace: string, ops: CanvasOp[], actor: CanvasActor | null = null): ApplyResult {
  const before = useCanvasStore.getState().pages[workspace] ?? [];
  const result = applyOps(before, ops);
  const activeId = useCanvasStore.getState().activePage[workspace];
  const patch: Partial<CanvasState> = { pages: { ...useCanvasStore.getState().pages, [workspace]: result.pages } };
  // La página que se miraba ya no está: se pasa a la primera que quede.
  if (activeId && !result.pages.some((p) => p.id === activeId)) {
    const activePage = { ...useCanvasStore.getState().activePage };
    if (result.pages[0]) activePage[workspace] = result.pages[0].id;
    else delete activePage[workspace];
    patch.activePage = activePage;
  }
  useCanvasStore.setState(patch);
  if (actor) markPresence(result.touched, actor);
  persistDiff(workspace, before, result.pages);
  return result;
}

export function newPageId(): string {
  return `p-${crypto.randomUUID().slice(0, 8)}`;
}

export function newNodeId(): string {
  return `n-${crypto.randomUUID().slice(0, 8)}`;
}

/** La página que se está mirando en ese workspace, creando una vacía si no hay ninguna. */
export function ensureActivePage(workspace: string, defaultName: string): CanvasPage {
  const state = useCanvasStore.getState();
  const pages = state.pages[workspace] ?? [];
  const active = pages.find((p) => p.id === state.activePage[workspace]) ?? pages[0];
  if (active) {
    if (state.activePage[workspace] !== active.id) setActivePage(workspace, active.id);
    return active;
  }
  const id = newPageId();
  const { pages: next } = dispatchCanvas(workspace, [{ op: "page.create", id, name: defaultName }]);
  setActivePage(workspace, id);
  return next.find((p) => p.id === id)!;
}

export function setActivePage(workspace: string, pageId: string) {
  useCanvasStore.setState((s) => ({ activePage: { ...s.activePage, [workspace]: pageId }, focusedItem: null }));
}

export function setCanvasMode(workspace: string, on: boolean) {
  useCanvasStore.setState((s) => {
    const canvasMode = { ...s.canvasMode };
    if (on) canvasMode[workspace] = true;
    else delete canvasMode[workspace];
    return { canvasMode, focusedItem: null };
  });
}

export function setCanvasFocus(key: string | null) {
  if (useCanvasStore.getState().focusedItem !== key) useCanvasStore.setState({ focusedItem: key });
}

export function requestView(request: Omit<ViewRequest, "nonce">) {
  useCanvasStore.setState({ viewRequest: { ...request, nonce: Date.now() + Math.random() } });
}

// ── Lo de la ventana ────────────────────────────────────────────────

const KEY = "cc-canvas";

/** Recuerda el modo y la página activa de cada workspace de esta ventana. */
export function initCanvasPersistence(windowLabel: string): () => void {
  const key = `${KEY}:${windowLabel}`;
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? (JSON.parse(raw) as { canvasMode?: unknown; activePage?: unknown }) : {};
    const record = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, never>) : {});
    useCanvasStore.setState({
      canvasMode: Object.fromEntries(Object.entries(record(saved.canvasMode)).filter(([, on]) => on === true)),
      activePage: Object.fromEntries(Object.entries(record(saved.activePage)).filter(([, id]) => typeof id === "string")),
    });
  } catch {
    /* sin recuerdo, todo en tabs: es lo mismo que la primera vez */
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = useCanvasStore.subscribe((state, prev) => {
    if (state.canvasMode === prev.canvasMode && state.activePage === prev.activePage) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({ canvasMode: state.canvasMode, activePage: state.activePage }));
      } catch {
        /* no poder recordarlo no impide usarlo */
      }
    }, 300);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}
