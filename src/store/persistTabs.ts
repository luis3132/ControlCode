import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "./tabs";

const SAVE_DEBOUNCE_MS = 400;
const SCROLLBACK_REFRESH_MS = 20_000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// El scrollback de cada PTY puede pesar hasta MAX_BUFFER_BYTES (3MB, ver pty_manager.rs).
// Antes, CADA guardado (incluido el debounce de 400ms disparado por renombrar/reordenar/
// activar una tab) volvía a pedir por IPC el scrollback completo de TODAS las tabs y
// reescribía la fila entera en SQLite — con varias tabs de agentes activos eso significa
// megabytes de tráfico IPC + disco en cada click. El scrollback solo hace falta fresco
// para sobrevivir a un crash, no en cada cambio de metadata, así que se cachea por ptyId
// y solo se refresca en el ciclo periódico de 20s (o si todavía no hay nada cacheado).
const scrollbackCache = new Map<number, string>();

// `saveNow` es async (espera bounds + scrollback de cada PTY vía IPC) y se dispara desde
// dos fuentes independientes (debounce de 400ms y el refresco periódico de 20s) — sin
// serializar, dos llamadas superpuestas pueden llegar a `db_save_window_state` en orden
// distinto al que se dispararon (la más vieja termina después si tiene más tabs/PTYs que
// leer), y como ese comando hace DELETE+INSERT completo, la que llega última pisa a la
// otra — así se perdía un rename de tab reciente bajo un snapshot viejo. Encolar cada
// llamada tras la anterior garantiza que se ejecuten en el mismo orden en que se
// dispararon, y cada una lee el estado más fresco al empezar (no al encolarse).
let saveChain: Promise<void> = Promise.resolve();

function enqueueSave(opts?: { refreshScrollback: boolean }) {
  const run = () => saveNow(opts);
  saveChain = saveChain.then(run, run);
}

async function fetchScrollback(ptyId: number | null): Promise<string | null> {
  if (ptyId == null) return null;
  try {
    const data = await invoke<string>("pty_attach", { id: ptyId });
    scrollbackCache.set(ptyId, data);
    return data;
  } catch {
    scrollbackCache.delete(ptyId); // el proceso ya no existe
    return null;
  }
}

/** Usa el scrollback cacheado si hay uno (guardados "rápidos" de metadata); si el PTY
 * todavía no tiene nada cacheado (tab recién creada), lo pide una vez igual. */
async function cachedOrFetchScrollback(ptyId: number | null): Promise<string | null> {
  if (ptyId == null) return null;
  const cached = scrollbackCache.get(ptyId);
  if (cached !== undefined) return cached;
  return fetchScrollback(ptyId);
}

async function saveNow(opts: { refreshScrollback: boolean } = { refreshScrollback: false }) {
  const win = getCurrentWindow();
  const { tabs, workspaceId } = useTabsStore.getState();
  const resolveScrollback = opts.refreshScrollback ? fetchScrollback : cachedOrFetchScrollback;

  let bounds: { x: number | null; y: number | null; width: number | null; height: number | null } = {
    x: null, y: null, width: null, height: null,
  };
  try {
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    bounds = { x: pos.x, y: pos.y, width: size.width, height: size.height };
  } catch {
    // ventana ya cerrándose; se guarda solo el estado de tabs
  }

  const tabsPayload = await Promise.all(
    tabs.map(async (t, i) => ({
      id: t.id,
      title: t.title,
      titleIsCustom: t.titleIsCustom ?? false,
      agentId: t.agentId,
      agentLabel: t.agentLabel,
      command: t.command,
      cwd: t.cwd,
      tabOrder: i,
      sessionId: t.sessionId ?? null,
      historyId: t.historyId ?? null,
      scrollback: await resolveScrollback(t.ptyId),
      openedAt: t.openedAt,
    }))
  );

  // Podar entradas de PTYs que ya no pertenecen a ninguna tab de esta ventana (cerradas,
  // transferidas a otra ventana) — el Map, si no, crece sin límite durante toda la sesión.
  const liveIds = new Set(tabs.map((t) => t.ptyId).filter((id): id is number => id != null));
  for (const cachedId of scrollbackCache.keys()) {
    if (!liveIds.has(cachedId)) scrollbackCache.delete(cachedId);
  }

  await invoke("db_save_window_state", {
    state: {
      label: win.label,
      workspaceId,
      posX: bounds.x,
      posY: bounds.y,
      width: bounds.width,
      height: bounds.height,
      monitor: null,
      tabs: tabsPayload,
    },
  }).catch(console.error);
}

function scheduleSave() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(enqueueSave, SAVE_DEBOUNCE_MS);
}

/** Fuerza el guardado inmediato del estado actual y espera a que termine, saltándose el
 * debounce de 400ms. Imprescindible antes de cualquier `getCurrentWindow().close()`
 * disparado por el propio JS (ej. al vaciar la última tab tras un detach/merge): si se
 * cierra la ventana con un guardado pendiente en el debounce, ese guardado nunca llega a
 * ejecutarse y la fila de esta ventana en SQLite queda con la tab que se acaba de mover —
 * duplicada con la copia que ya persistió la ventana destino. Ver bug: dos filas en
 * `windows` con la misma tab, ambas revividas al reabrir la app. */
export async function flushPendingSave(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  enqueueSave();
  await saveChain;
}

/** Centraliza el guardado automático del estado de tabs/ventana hacia SQLite. */
export function initTabsPersistence() {
  if (initialized) return;
  initialized = true;

  useTabsStore.subscribe((state, prevState) => {
    if (!state.hydrated) return;
    if (state.tabs === prevState.tabs && state.workspaceId === prevState.workspaceId) return;
    scheduleSave();
  });

  listen("cc-window-bounds-changed", () => {
    if (useTabsStore.getState().hydrated) scheduleSave();
  });

  // "Guardar workspace" mueve en la DB todas las ventanas abiertas del workspace de
  // origen. Esta ventana puede ser una de las movidas sin haber sido la que disparó el
  // guardado, así que adopta el id nuevo en vez de seguir autosalvando contra el viejo.
  listen<string>("cc-workspace-reassigned", (event) => {
    try {
      const { from, to } = JSON.parse(event.payload) as { from: string; to: string };
      const store = useTabsStore.getState();
      if (store.workspaceId === from && from !== to) store.setWorkspaceId(to);
    } catch {
      // payload malformado: no hay nada seguro que hacer, se ignora
    }
  });

  // Refresco periódico del scrollback (aunque no cambie nada en el array de tabs,
  // el contenido de la terminal sí cambia) para no perder mucho si la app se cae.
  setInterval(() => {
    if (useTabsStore.getState().hydrated) enqueueSave({ refreshScrollback: true });
  }, SCROLLBACK_REFRESH_MS);

  // Sin listener de onCloseRequested a propósito: en Tauri 2, registrar uno
  // intercepta el cierre nativo de la ventana hasta que el JS responda, y eso
  // es justo lo que rompía el botón de cerrar. El guardado por debounce ya
  // mantiene la DB al día (a lo sumo se pierden los últimos ~400ms de cambios).
}
