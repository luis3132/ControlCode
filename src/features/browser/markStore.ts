import type { AnnotatedCapture } from "./composeMessage";
import type { PickedElement } from "./protocol";

/**
 * Lo que la persona le mandó a cada agente desde el navegador, esperando a que lo lea.
 *
 * ## Por qué hay un registro y no alcanza con la tab
 *
 * Al mandar, al agente se le pega un aviso ("marqué esto, leelo con `browser_marked`") y el
 * panel se vacía. Lo marcado tiene que sobrevivir a ese momento, y tiene que poder buscarse
 * **por su id**: el aviso lleva el id, el agente pregunta por ese id y recibe exactamente
 * eso. Sin id, con dos agentes y dos tabs de navegador, "lo último que marcó el usuario" es
 * una adivinanza — y adivinar mal significa que un agente trabaja sobre lo que le marcaron
 * a otro.
 *
 * Vive acá y no en la tab del navegador porque la búsqueda por id no puede depender de en
 * qué tab se marcó: el agente solo tiene el id.
 */

/** Cada cosa señalada tiene el suyo: `m-…` un envío, `s-…` una captura. */
export type MarkId = string;

export interface SentBatch {
  id: MarkId;
  /** La tab del agente al que se le mandó. */
  agentId: string;
  /** En qué tab de navegador se marcó: es donde se pueden volver a describir los elementos. */
  viewId: string;
  at: number;
  picks: PickedElement[];
  captures: AnnotatedCapture[];
  note: string;
}

/** Cuántos envíos sin leer se guardan. Pasados esos, el más viejo ya no le importa a nadie. */
const KEEP = 12;

const batches = new Map<MarkId, SentBatch>();

/** Un id corto, único y reconocible: `m-3f9a71c4` un envío, `s-0b12e4aa` una captura. */
export function newMarkId(kind: "m" | "s"): MarkId {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(16).slice(2).padEnd(8, "0");
  return `${kind}-${random.slice(0, 8)}`;
}

export function rememberMarks(batch: SentBatch): void {
  batches.set(batch.id, batch);
  // Se tiran los más viejos, que son los primeros que se agregaron.
  for (const id of [...batches.keys()].slice(0, Math.max(0, batches.size - KEEP))) batches.delete(id);
}

/** Lo que espera un agente, del más nuevo al más viejo. */
export function batchesFor(agentId: string): SentBatch[] {
  return [...batches.values()].filter((b) => b.agentId === agentId).sort((a, b) => b.at - a.at);
}

/** Cuántos envíos hay esperando a otros agentes: sirve para decirle a uno que eso no es suyo. */
export function pendingCount(): number {
  return batches.size;
}

/**
 * El envío de ese id. También se encuentra por el id de UNA de sus capturas: en el aviso van
 * los dos, y no hay razón para que el agente tenga que elegir bien cuál pegar.
 */
export function batchById(id: MarkId): SentBatch | undefined {
  return batches.get(id) ?? [...batches.values()].find((b) => b.captures.some((c) => c.id === id));
}

/** El agente ya lo leyó: se borra para que no lo vuelva a leer como si fuera nuevo. */
export function consumeMarks(id: MarkId): void {
  batches.delete(id);
}

/** Para los tests. */
export function forgetAllMarks(): void {
  batches.clear();
}
