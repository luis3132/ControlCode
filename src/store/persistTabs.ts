import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "./tabs";

const SAVE_DEBOUNCE_MS = 400;
const SCROLLBACK_REFRESH_MS = 20_000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// `saveNow` es async (espera bounds + scrollback de cada PTY vía IPC) y se dispara desde
// dos fuentes independientes (debounce de 400ms y el refresco periódico de 20s) — sin
// serializar, dos llamadas superpuestas pueden llegar a `db_save_window_state` en orden
// distinto al que se dispararon (la más vieja termina después si tiene más tabs/PTYs que
// leer), y como ese comando hace DELETE+INSERT completo, la que llega última pisa a la
// otra — así se perdía un rename de tab reciente bajo un snapshot viejo. Encolar cada
// llamada tras la anterior garantiza que se ejecuten en el mismo orden en que se
// dispararon, y cada una lee el estado más fresco al empezar (no al encolarse).
let saveChain: Promise<void> = Promise.resolve();

function enqueueSave() {
  saveChain = saveChain.then(saveNow, saveNow);
}

async function fetchScrollback(ptyId: number | null): Promise<string | null> {
  if (ptyId == null) return null;
  try {
    return await invoke<string>("pty_attach", { id: ptyId });
  } catch {
    return null; // el proceso ya no existe
  }
}

async function saveNow() {
  const win = getCurrentWindow();
  const { tabs, workspaceId } = useTabsStore.getState();

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
      scrollback: await fetchScrollback(t.ptyId),
      openedAt: t.openedAt,
    }))
  );

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

  // Refresco periódico del scrollback (aunque no cambie nada en el array de tabs,
  // el contenido de la terminal sí cambia) para no perder mucho si la app se cae.
  setInterval(() => {
    if (useTabsStore.getState().hydrated) enqueueSave();
  }, SCROLLBACK_REFRESH_MS);

  // Sin listener de onCloseRequested a propósito: en Tauri 2, registrar uno
  // intercepta el cierre nativo de la ventana hasta que el JS responda, y eso
  // es justo lo que rompía el botón de cerrar. El guardado por debounce ya
  // mantiene la DB al día (a lo sumo se pierden los últimos ~400ms de cambios).
}
