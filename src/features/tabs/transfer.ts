import { listen } from "@tauri-apps/api/event";

import { broadcastEvent } from "@/shared/ipc/window";

import type { Tab } from "./types";

/**
 * Mover una tab de una ventana a otra, con su proceso vivo.
 *
 * ## Por qué viaja la tab ENTERA
 *
 * Antes se enumeraban los campos a mano (`cwd`, `command`, `agentId`, …) y los que no
 * estaban en esa lista se perdían en el camino. Se perdían cuatro, y ninguno daba error:
 *
 * - `historyId` → al cerrarla en el destino se archivaba una entrada NUEVA del historial
 *   en vez de actualizar la suya.
 * - `prelaunch` → la tab quedaba sin su cadena de pre-lanzamiento.
 * - `titleIsCustom` → el título puesto a mano dejaba de estar protegido y lo pisaba el
 *   refresco automático.
 * - `openedAt` → pasaba a ser "ahora", y como es el piso temporal del descubrimiento de
 *   sesión, el transcript de un proceso que llevaba horas vivo quedaba descartado: la tab
 *   perdía para siempre su id de sesión (y con él, poder reanudarla).
 *
 * Mandando la tab completa, agregarle un campo a `Tab` no vuelve a abrir este agujero.
 */
export interface TabTransfer {
  /** Ventana destino. Cada ventana escucha, pero solo actúa si el evento la nombra. */
  targetLabel: string;
  tab: Tab;
  /**
   * Workspace de la ventana de origen. Solo lo adopta una ventana **vacía** (el caso de
   * arrastrar la tab afuera, que crea una ventana nueva): si no, la tab quedaría huérfana
   * en el bucket `default`. Una ventana con tabs ya tiene el suyo y no se toca.
   */
  workspaceId: string;
}

const TRANSFER_EVENT = "cc-receive-tab";
const READY_EVENT = "cc-window-ready";

/** Cuánto se espera a que la ventana recién creada esté lista para recibir la tab. */
const READY_TIMEOUT_MS = 10_000;

export function sendTab(transfer: TabTransfer): Promise<void> {
  return broadcastEvent(TRANSFER_EVENT, JSON.stringify(transfer));
}

export function onTabReceived(handle: (transfer: TabTransfer) => void) {
  return listen<string>(TRANSFER_EVENT, (event) => {
    try {
      const transfer = JSON.parse(event.payload) as TabTransfer;
      if (transfer?.tab?.id) handle(transfer);
    } catch {
      // payload malformado: no hay nada seguro que hacer
    }
  });
}

/** La ventana avisa que ya montó y está escuchando transferencias. */
export function announceWindowReady(label: string): Promise<void> {
  return broadcastEvent(READY_EVENT, label);
}

/**
 * Espera a que la ventana `label` avise que está lista.
 *
 * Hace falta porque el evento de transferencia es efímero: mandarlo apenas vuelve
 * `open_new_window` lo perdería, porque el JS de esa ventana todavía no registró su
 * listener. Antes esto se resolvía dejando la tab en `localStorage` para que la levantara
 * "la próxima ventana que arranque" — un buzón sin destinatario, que con dos ventanas
 * abriéndose a la vez podía depositar la tab en la equivocada.
 *
 * Resuelve `false` si la ventana no avisa en `READY_TIMEOUT_MS`: quien llama conserva la
 * tab en el origen en vez de tirarla a una ventana que quizá nunca abrió.
 */
export async function waitForWindow(label: string): Promise<boolean> {
  let unlisten: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      listen<string>(READY_EVENT, (event) => {
        if (event.payload !== label) return;
        clearTimeout(timer);
        resolve(true);
      }).then((fn) => {
        unlisten = fn;
      });
    });
  } finally {
    unlisten?.();
  }
}

/**
 * Clave del traspaso de workspace a una ventana que todavía no existe ("Nueva ventana"
 * del menú). Lleva el label del destinatario: `localStorage` es compartido por todas las
 * ventanas del mismo origen, así que una clave sin dueño la consume la primera que
 * arranque — con dos abriéndose a la vez, una se queda sin su workspace.
 *
 * Es `localStorage` y no un evento porque la ventana destino tiene que leerlo ANTES de su
 * primer autosave, y para entonces todavía no está escuchando nada.
 */
export function newWindowWorkspaceKey(label: string): string {
  return `cc-new-window-workspace:${label}`;
}
