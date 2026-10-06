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
