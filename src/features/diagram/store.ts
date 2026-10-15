import { create } from "zustand";

import { markPresence, type CanvasActor } from "@/features/canvas/store";
import { fileStat, readFile, writeFile } from "@/features/editor/ipc";

import { writeNewFile } from "./files";
import { layoutDiagram, type LayoutDirection } from "./layout";
import { applyDiagramOps, EMPTY_DIAGRAM, parseDiagram, serializeDiagram, type Diagram, type DiagramOp, type DiagramResult } from "./model";

/**
 * Los diagramas abiertos, por ruta. El archivo es la verdad: se carga al abrirlo, cada
 * cambio se guarda poco después, y si otro lo cambia en disco (un agente que escribió el
 * JSON, un `git checkout`) se relee — salvo que haya un cambio nuestro sin guardar.
 *
 * Todo cambio pasa por `dispatchDiagram`, venga del editor o de un agente (ver
 * `agentBridge.ts`). Lo que toca un agente queda pintado de su color con la misma presencia
 * que el canvas: la clave es `<ruta>#<id>`.
 */

interface DiagramDoc {
  diagram: Diagram;
  /** El mtime con que se leyó o se guardó por última vez. */
  mtime: number | null;
  /** Hay un cambio esperando para guardarse. */
  pending: boolean;
  past: Diagram[];
  future: Diagram[];
  error?: string;
}

interface DiagramState {
  docs: Record<string, DiagramDoc>;
}

export const useDiagramStore = create<DiagramState>(() => ({ docs: {} }));

const HISTORY = 100;
const SAVE_MS = 500;
const WATCH_MS = 2000;

export const presenceKey = (path: string, id: string) => `${path}#${id}`;

export const isDiagramPath = (path: string) => /\.diagram\.json$/i.test(path);

function setDoc(path: string, patch: Partial<DiagramDoc>) {
  useDiagramStore.setState((s) => {
    const current = s.docs[path] ?? { diagram: EMPTY_DIAGRAM, mtime: null, pending: false, past: [], future: [] };
    return { docs: { ...s.docs, [path]: { ...current, ...patch } } };
  });
}

const loading = new Map<string, Promise<Diagram>>();

/** El diagrama de esa ruta, leyéndolo del disco la primera vez. */
export function loadDiagram(path: string): Promise<Diagram> {
  const doc = useDiagramStore.getState().docs[path];
  if (doc && !doc.error) return Promise.resolve(doc.diagram);
  const pending = loading.get(path);
  if (pending) return pending;
  const promise = readFile(path)
    .then((content) => {
      if (content.kind !== "text") throw new Error(`${path} no es un archivo de texto`);
      const diagram = parseDiagram(content.content);
      setDoc(path, { diagram, mtime: content.mtime, pending: false, error: undefined });
      return diagram;
    })
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      setDoc(path, { error: message });
      throw new Error(message);
    })
    .finally(() => loading.delete(path));
  loading.set(path, promise);
  return promise;
}

/** Crea el archivo de un diagrama vacío. Falla si ya existe: no se pisa nada. */
export async function createDiagram(path: string, title?: string): Promise<Diagram> {
  const exists = await fileStat(path).catch(() => null);
  if (exists) throw new Error(`Ya existe ${path}: abrilo o elegí otro nombre`);
  const diagram: Diagram = title ? { ...EMPTY_DIAGRAM, title } : EMPTY_DIAGRAM;
  const mtime = await writeNewFile(path, { text: serializeDiagram(diagram) });
  setDoc(path, { diagram, mtime, pending: false, past: [], future: [], error: undefined });
  return diagram;
}

// ── Guardar ─────────────────────────────────────────────────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(path: string) {
  const prev = saveTimers.get(path);
  if (prev) clearTimeout(prev);
  saveTimers.set(path, setTimeout(() => {
    saveTimers.delete(path);
    saveNow(path).catch(console.error);
  }, SAVE_MS));
}

export async function saveNow(path: string): Promise<void> {
  const doc = useDiagramStore.getState().docs[path];
  if (!doc || !doc.pending) return;
  const outcome = await writeFile(path, serializeDiagram(doc.diagram), doc.mtime);
  // Lo cambió otro mientras se editaba acá: gana lo de acá, que es lo que se está viendo y lo
  // que el usuario (o el agente) acaba de hacer. Lo de afuera queda en el historial de git.
  const saved = outcome.kind === "conflict" ? await writeFile(path, serializeDiagram(doc.diagram), null) : outcome;
  // Si entretanto hubo otro cambio, sigue pendiente (su propio guardado ya está programado).
  const latest = useDiagramStore.getState().docs[path];
  setDoc(path, { mtime: saved.mtime, pending: latest?.diagram !== doc.diagram });
}

// ── Cambios ─────────────────────────────────────────────────────────

function commit(path: string, before: Diagram, after: Diagram, touched: string[], actor: CanvasActor | null) {
  if (after === before) return;
  const doc = useDiagramStore.getState().docs[path];
  setDoc(path, {
    diagram: after,
    pending: true,
    past: [...(doc?.past ?? []), before].slice(-HISTORY),
    future: [],
  });
  if (actor && touched.length > 0) markPresence(touched.map((id) => presenceKey(path, id)), actor);
  scheduleSave(path);
}

/**
 * Aplica operaciones a un diagrama ya cargado. Tira el error de la que falle sin aplicar
 * ninguna. Con `actor`, lo que tocó queda pintado de su color un rato.
 */
export function dispatchDiagram(path: string, ops: DiagramOp[], actor: CanvasActor | null = null): DiagramResult {
  const doc = useDiagramStore.getState().docs[path];
  if (!doc) throw new Error(`El diagrama ${path} no está cargado`);
  const result = applyDiagramOps(doc.diagram, ops);
  commit(path, doc.diagram, result.diagram, result.touched, actor);
  return result;
}

/** Acomoda el diagrama solo (ver `layout.ts`), como un cambio más: se deshace igual. */
export async function layoutAndCommit(path: string, direction: LayoutDirection, actor: CanvasActor | null = null): Promise<Diagram> {
  const before = useDiagramStore.getState().docs[path]?.diagram;
  if (!before) throw new Error(`El diagrama ${path} no está cargado`);
  const after = await layoutDiagram(before, direction);
  // Si mientras se calculaba llegó otro cambio, se acomoda eso y no lo de antes.
  const now = useDiagramStore.getState().docs[path]?.diagram;
  if (now !== before) return layoutAndCommit(path, direction, actor);
  commit(path, before, after, actor ? after.nodes.map((n) => n.id) : [], actor);
  return after;
}

export function undo(path: string) {
  const doc = useDiagramStore.getState().docs[path];
  const previous = doc?.past[doc.past.length - 1];
  if (!doc || !previous) return;
  setDoc(path, { diagram: previous, past: doc.past.slice(0, -1), future: [doc.diagram, ...doc.future], pending: true });
  scheduleSave(path);
}

export function redo(path: string) {
  const doc = useDiagramStore.getState().docs[path];
  const next = doc?.future[0];
  if (!doc || !next) return;
  setDoc(path, { diagram: next, past: [...doc.past, doc.diagram], future: doc.future.slice(1), pending: true });
  scheduleSave(path);
}

// ── Lo que cambia en disco ──────────────────────────────────────────

const watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

/** Mientras haya alguien mirando el diagrama, se relee si otro cambia el archivo. */
export function watchDiagram(path: string): () => void {
  const existing = watchers.get(path);
  if (existing) existing.count++;
  else {
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const doc = useDiagramStore.getState().docs[path];
      if (!doc || doc.pending || saveTimers.has(path)) return;
      const stat = await fileStat(path).catch(() => undefined);
      if (!stat || stat.mtime === doc.mtime) return;
      const content = await readFile(path).catch(() => null);
      if (content?.kind !== "text") return;
      // Revisar de nuevo: puede haber llegado un cambio nuestro mientras se leía.
      const latest = useDiagramStore.getState().docs[path];
      if (!latest || latest.pending) return;
      try {
        const diagram = parseDiagram(content.content);
        setDoc(path, { diagram, mtime: content.mtime, past: [...latest.past, latest.diagram].slice(-HISTORY), future: [], error: undefined });
      } catch (e) {
        // Un JSON a medio escribir: se espera a la próxima vuelta.
        console.warn(e);
      }
    };
    // Enseguida y después cada tanto: lo que esté en memoria pudo haber cambiado en disco
    // mientras nadie lo miraba.
    check().catch(console.error);
    const timer = setInterval(() => check().catch(console.error), WATCH_MS);
    watchers.set(path, { count: 1, timer });
  }
  return () => {
    const w = watchers.get(path);
    if (!w) return;
    w.count--;
    if (w.count <= 0) {
      clearInterval(w.timer);
      watchers.delete(path);
    }
  };
}
