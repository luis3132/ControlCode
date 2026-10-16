import { create } from "zustand";

import { markPresence, type CanvasActor } from "@/features/canvas/store";
import { fileStat, readFile } from "@/features/editor/ipc";
import { writeNewFile } from "@/features/diagram/files";

import { applyDocEdit, type DocEdit } from "./edit";

/**
 * Los documentos que se están mirando en el canvas, por ruta, con su texto al día.
 *
 * El archivo es la verdad: se relee cada segundo mientras alguien lo mira, así lo que
 * escribe un agente —con `doc_write` o con sus propias herramientas— aparece enseguida.
 * Lo que escribe con `doc_write` además queda firmado: se pinta del color del agente.
 */

interface DocState {
  texts: Record<string, { text: string; mtime: number } | { error: string }>;
  /** La última edición de un agente, para llevar la vista a lo nuevo. */
  lastEdit: Record<string, { by: string; at: number; mode: DocEdit["mode"] }>;
}

export const useDocsStore = create<DocState>(() => ({ texts: {}, lastEdit: {} }));

export const isDocPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** La clave de presencia de un documento: lo pinta del color de quien lo escribió. */
export const docPresenceKey = (path: string) => `${path}#doc`;

const WATCH_MS = 1000;

async function refresh(path: string) {
  const current = useDocsStore.getState().texts[path];
  if (current && "mtime" in current) {
    const stat = await fileStat(path).catch(() => undefined);
    if (stat && stat.mtime === current.mtime) return;
  }
  try {
    const file = await readFile(path);
    const next = file.kind === "text" ? { text: file.content, mtime: file.mtime } : { error: `${path} no es un documento de texto` };
    useDocsStore.setState((s) => ({ texts: { ...s.texts, [path]: next } }));
  } catch (e) {
    useDocsStore.setState((s) => ({ texts: { ...s.texts, [path]: { error: e instanceof Error ? e.message : String(e) } } }));
  }
}

const watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

/** Mientras haya alguien mirándolo, el texto se mantiene al día con el disco. */
export function watchDoc(path: string): () => void {
  const existing = watchers.get(path);
  if (existing) existing.count++;
  else {
    refresh(path).catch(console.error);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh(path).catch(console.error);
    }, WATCH_MS);
    watchers.set(path, { count: 1, timer });
  }
  return () => {
    const w = watchers.get(path);
    if (!w) return;
    if (--w.count <= 0) {
      clearInterval(w.timer);
      watchers.delete(path);
    }
  };
}

/** El texto actual del archivo (del disco, no de lo que hay en memoria). `""` si no existe. */
export async function readDocText(path: string): Promise<string> {
  const stat = await fileStat(path).catch(() => null);
  if (!stat) return "";
  const file = await readFile(path);
  if (file.kind !== "text") throw new Error(`${path} no es un documento de texto`);
  return file.content;
}

/** Crea un documento. Falla si ya existe: no se pisa nada. */
export async function createDoc(path: string, text: string): Promise<void> {
  if (await fileStat(path).catch(() => null)) throw new Error(`Ya existe ${path}: escribile con doc_write o elegí otro nombre`);
  const mtime = await writeNewFile(path, { text: text.endsWith("\n") ? text : `${text}\n` });
  useDocsStore.setState((s) => ({ texts: { ...s.texts, [path]: { text, mtime } } }));
}

/** Cambia un documento (ver `applyDocEdit`) y lo firma con el color de quien lo hizo. */
export async function editDoc(path: string, edit: DocEdit, actor: CanvasActor | null): Promise<string> {
  const next = applyDocEdit(await readDocText(path), edit);
  const mtime = await writeNewFile(path, { text: next });
  useDocsStore.setState((s) => ({
    texts: { ...s.texts, [path]: { text: next, mtime } },
    lastEdit: actor ? { ...s.lastEdit, [path]: { by: actor.label, at: Date.now(), mode: edit.mode } } : s.lastEdit,
  }));
  if (actor) markPresence([docPresenceKey(path)], actor);
  return next;
}

/** Lo que acaba de guardar el editor del nodo: así la vista previa no espera a releerlo. */
export function setDocText(path: string, text: string, mtime: number) {
  useDocsStore.setState((s) => ({ texts: { ...s.texts, [path]: { text, mtime } } }));
}
