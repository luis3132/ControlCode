import { create } from "zustand";

/**
 * Terminales hibernadas: su tab lleva un rato sin verse, así que se desmonta la xterm (con
 * su scrollback en memoria, sus listeners y su DOM) **sin matar el proceso**. El agente
 * sigue trabajando y su salida se sigue guardando en el buffer de Rust; al volver a la tab
 * se monta otra xterm que se reconecta y la repinta (`attachPtyId`).
 */
export const useHibernation = create<{ ids: Set<string> }>(() => ({ ids: new Set() }));

export const isHibernated = (tabId: string) => useHibernation.getState().ids.has(tabId);

export function hibernate(tabIds: string[]) {
  if (tabIds.length === 0) return;
  useHibernation.setState((s) => ({ ids: new Set([...s.ids, ...tabIds]) }));
}

/** `true` si estaba hibernada (y ahora se va a montar de nuevo). */
export function wake(tabId: string): boolean {
  if (!isHibernated(tabId)) return false;
  useHibernation.setState((s) => {
    const ids = new Set(s.ids);
    ids.delete(tabId);
    return { ids };
  });
  return true;
}

/**
 * Las tabs que ya tienen que hibernar: ocultas desde hace más de `minutes`. `minutes` 0 =
 * nunca. `hiddenSince` tiene, por tab, desde cuándo no se ve (epoch ms).
 */
export function dueForHibernation(
  hiddenSince: ReadonlyMap<string, number>,
  now: number,
  minutes: number,
  already: ReadonlySet<string>
): string[] {
  if (minutes <= 0) return [];
  const limit = minutes * 60_000;
  return [...hiddenSince].filter(([id, since]) => !already.has(id) && now - since >= limit).map(([id]) => id);
}

/**
 * Tabs restauradas que todavía no se miraron: su TUI no se lanza hasta que se muestren por
 * primera vez (o hasta que algo les pegue texto). Al abrir la app se reanudaban TODAS a la
 * vez —con trece tabs, trece `claude` de 200-400 MB cada uno— aunque se fuera a mirar una
 * sola. Una tab abierta en esta sesión nunca está acá: arranca enseguida, porque quien la
 * abrió puede estar esperando que conteste (la flota, `sendWhenReady`).
 */
export const useDormant = create<{ ids: Set<string> }>(() => ({ ids: new Set() }));

export function markDormant(tabIds: string[]) {
  if (tabIds.length === 0) return;
  useDormant.setState((s) => ({ ids: new Set([...s.ids, ...tabIds]) }));
}

/** `true` si estaba dormida (y ahora se va a lanzar). */
export function rouse(tabId: string): boolean {
  if (!useDormant.getState().ids.has(tabId)) return false;
  useDormant.setState((s) => {
    const ids = new Set(s.ids);
    ids.delete(tabId);
    return { ids };
  });
  return true;
}
