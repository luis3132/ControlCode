import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "@/features/tabs/store";
import { ptyCwd, ptyOutputTotals } from "@/features/terminal/ipc";
import { rememberShellCwd } from "@/features/terminal/shellCwd";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { discoverSessionId } from "@/features/sessions/ipc";
import { isResumable } from "@/features/sessions/agentResume";
import { LOOKBACK_S } from "@/features/terminal/sessionDiscovery";
import { saveWindowState } from "./ipc";

const SAVE_DEBOUNCE_MS = 400;
const SCROLLBACK_REFRESH_MS = 20_000;
/** Con la ventana oculta o minimizada el refresco periódico se espacia: nadie está
 *  mirando, y lo único que protege es lo que se perdería si la app se cae. */
const HIDDEN_REFRESH_MS = 120_000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// El scrollback de cada PTY puede pesar hasta 3 MB (ver pty_manager.rs) y NO viaja en el
// guardado: la tab viva manda su `ptyId` y el backend lo lee de su propio buffer, solo si
// el proceso escribió algo desde la última vez. Antes cada guardado copiaba por IPC el de
// todas las tabs (decenas de MB serializados en el hilo de la interfaz, que la congelaban)
// y la base lo reescribía entero aunque no hubiera cambiado.
/** Cuánto había escrito cada PTY en el último guardado: el periódico no escribe si ninguno
 *  escribió nada nuevo. */
const savedTotals = new Map<number, number>();
/** Las tabs dormidas que ya se guardaron desde esta ventana: su scrollback (el que trajeron
 *  de la base) ya está ahí, y no hace falta volver a mandarlo. */
const savedDormant = new Set<string>();
/** Lo último que se escribió en la base, para no reescribir lo mismo cada 20 s. */
let lastSaved: { tabs: unknown; workspaceId: unknown } | null = null;
let lastPeriodicAt = 0;

// `saveNow` es async (espera bounds + scrollback de cada PTY vía IPC) y se dispara desde
// dos fuentes independientes (debounce de 400ms y el refresco periódico de 20s) — sin
// serializar, dos llamadas superpuestas pueden llegar a `db_save_window_state` en orden
// distinto al que se dispararon (la más vieja termina después si tiene más tabs/PTYs que
// leer), y como ese comando hace DELETE+INSERT completo, la que llega última pisa a la
// otra — así se perdía un rename de tab reciente bajo un snapshot viejo. Encolar cada
// llamada tras la anterior garantiza que se ejecuten en el mismo orden en que se
// dispararon, y cada una lee el estado más fresco al empezar (no al encolarse).
let saveChain: Promise<void> = Promise.resolve();

/** Después del guardado de cierre no se guarda más: las terminales se matan enseguida, y un
 *  guardado posterior (el periódico de 20 s) leería el scrollback de un PTY que ya no
 *  existe y pisaría con `null` el que se acaba de guardar. */
let frozen = false;

function enqueueSave(opts?: SaveOptions) {
  if (frozen) return;
  const run = () => saveNow(opts);
  saveChain = saveChain.then(run, run);
}

interface SaveOptions {
  refreshScrollback: boolean;
  /** El refresco periódico: si nada cambió desde el último guardado, no escribe. */
  periodic?: boolean;
}

/** Cuánto va de un guardado: pasos hechos de un total que se conoce desde el principio. */
export type SaveProgress = (done: number, total: number, step: SaveStep) => void;

/** Qué se acaba de terminar: la posición de la ventana, una terminal, o la escritura. */
export type SaveStep =
  | { kind: "start" }
  | { kind: "bounds" }
  | { kind: "terminal"; title: string }
  | { kind: "write" };

async function saveNow(
  opts: SaveOptions = { refreshScrollback: false },
  progress?: SaveProgress,
) {
  const win = getCurrentWindow();
  const { tabs, workspaceId, hydrated } = useTabsStore.getState();

  // El periódico solo escribe si alguna terminal escribió algo (o cambiaron las tabs): el
  // backend relee el scrollback de las que cambiaron.
  const ids = tabs.map((t) => t.ptyId).filter((id): id is number => id != null);
  let totals: Record<string, number> = {};
  if (opts.refreshScrollback && ids.length) {
    totals = await ptyOutputTotals(ids).catch(() => ({} as Record<string, number>));
  }
  const anyOutput = ids.some((id) => totals[String(id)] !== undefined && savedTotals.get(id) !== totals[String(id)]);
  if (opts.periodic && !anyOutput && lastSaved?.tabs === tabs && lastSaved.workspaceId === workspaceId) return;
  // Posición + una lectura de scrollback por tab + la escritura en la base. Los pasos son
  // los reales: cada uno avisa cuando TERMINA, no cuando empieza.
  const total = tabs.length + 2;
  let done = 0;
  const step = (s: SaveStep) => progress?.(++done, total, s);
  progress?.(0, total, { kind: "start" });

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
  step({ kind: "bounds" });

  const tabsPayload = tabs.map((t, i) => {
    step({ kind: "terminal", title: t.title });
    const dormant = t.ptyId == null;
    return {
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
      accountId: t.accountId ?? null,
      prelaunch: t.prelaunch ?? [],
      // Sin proceso todavía (una tab dormida, ver `useDormant`) se guarda el que trajo al
      // restaurarse, una sola vez: si no, el primer guardado le borraba el historial a una
      // que no se miró. Después ya está en la base y basta con no tocarlo.
      scrollback: dormant && !savedDormant.has(t.id) ? t.scrollback ?? null : null,
      ptyId: t.ptyId ?? null,
      keepScrollback: dormant && savedDormant.has(t.id),
      openedAt: t.openedAt,
      mode: t.mode ?? "terminal" as const,
    };
  });

  // La carpeta de cada terminal pelada, para volver ahí al reabrir (ver `shellCwd.ts`). En
  // Linux y macOS se le pregunta al sistema; en Windows ya la avisó el propio PowerShell.
  await Promise.all(
    tabs
      .filter((t) => t.agentId === SHELL_AGENT_ID && t.ptyId != null)
      .map((t) => ptyCwd(t.ptyId!).then((path) => { if (path) rememberShellCwd(t.id, path); }, () => {}))
  );

  await saveWindowState({
    label: win.label,
    workspaceId,
    posX: bounds.x,
    posY: bounds.y,
    width: bounds.width,
    height: bounds.height,
    monitor: null,
    tabs: tabsPayload,
    // Solo una ventana ya hidratada puede afirmar "estas son TODAS mis tabs", que es lo
    // único que autoriza al backend a dar por cerradas las que falten. Ver
    // `WindowStatePayload::authoritative`.
    authoritative: hydrated,
  }).then(() => {
    lastSaved = { tabs, workspaceId };
    if (opts.refreshScrollback) {
      savedTotals.clear();
      for (const [id, total] of Object.entries(totals)) savedTotals.set(Number(id), total);
    }
    savedDormant.clear();
    for (const t of tabs) if (t.ptyId == null) savedDormant.add(t.id);
  }, console.error);
  step({ kind: "write" });
}

function scheduleSave() {
  if (frozen) return;
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
  // Nunca persistir un estado PRE-HIDRATACIÓN. El resto de los disparadores del guardado
  // (la suscripción al store y el ciclo periódico) ya se abstienen mientras `hydrated` sea
  // false; este se los saltaba, y era el único que el usuario podía disparar a mano.
  //
  // El daño no era perder un guardado: `db_save_window_state` trata a las tabs que NO
  // vienen en el payload como tabs cerradas —las archiva y BORRA su fila—, y
  // `project_skills.tab_id` cascadea con `tabs`. O sea que un flush disparado antes de que
  // la ventana terminara de hidratarse mandaba un payload sin sus tabs reales y se llevaba
  // puestas las skills de todas ellas, dejando además entradas de historial con `skills: []`
  // que ya no se podían reanudar con sus skills. Verificado sobre una base real.
  //
  // Se ESPERA a la hidratación en vez de saltear el guardado: quien llama a esto necesita
  // que la tab que acaba de crear exista como fila antes de attachearle nada (`attach_skill`
  // con scope='tab' la busca por id). El tope existe para no colgar la creación de una tab
  // si la hidratación nunca llegara.
  await waitForHydration();

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  enqueueSave();
  await saveChain;
}

/**
 * El guardado de antes de cerrar la ventana, con progreso: el scrollback de cada terminal
 * leído en ese momento (no el de hasta 20 s atrás) y todo escrito en la base.
 *
 * Una ventana que no terminó de hidratarse no guarda nada (ver `flushPendingSave`): su
 * payload no tiene sus tabs reales y borraría las que sí están. Avisa `0 de 0` y sigue.
 */
export async function saveForClose(progress: SaveProgress): Promise<void> {
  if (!useTabsStore.getState().hydrated) {
    progress(0, 0, { kind: "write" });
    return;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // Primero lo que ya estaba en cola: si no, un guardado viejo podría terminar después
  // y pisar a este.
  await saveChain;
  frozen = true;
  await lastChanceSessions();
  const run = () => saveNow({ refreshScrollback: true }, progress);
  saveChain = saveChain.then(run, run);
  await saveChain;
}

/** Cuánto se le da, como mucho, al último intento de descubrir sesiones al cerrar. */
const LAST_CHANCE_MS = 3_000;

/**
 * Antes de guardar por última vez, las tabs de agente que todavía no saben su sesión la
 * buscan una vez más. Sin id, al reabrir la app el agente arranca de cero aunque haya una
 * conversación entera en disco. Con tope de tiempo: cerrar no puede quedar esperando.
 */
async function lastChanceSessions(): Promise<void> {
  const { tabs, setSessionId } = useTabsStore.getState();
  const pending = tabs.filter((t) => !t.sessionId && t.agentId !== SHELL_AGENT_ID && isResumable(t.agentId));
  if (pending.length === 0) return;
  const lookups = Promise.all(
    pending.map((t) =>
      discoverSessionId({
        agentId: t.agentId,
        cwd: t.cwd,
        startedAfter: t.openedAt - LOOKBACK_S,
        accountId: t.accountId ?? null,
      })
        .then((id) => { if (id) setSessionId(t.id, id); })
        .catch(() => {})
    )
  );
  await Promise.race([lookups, new Promise((resolve) => setTimeout(resolve, LAST_CHANCE_MS))]);
}

const HYDRATION_TIMEOUT_MS = 5_000;

function waitForHydration(): Promise<void> {
  if (useTabsStore.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, HYDRATION_TIMEOUT_MS);
    const unsubscribe = useTabsStore.subscribe((state) => {
      if (state.hydrated) done();
    });
  });
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
    if (!useTabsStore.getState().hydrated) return;
    const now = Date.now();
    if (document.visibilityState === "hidden" && now - lastPeriodicAt < HIDDEN_REFRESH_MS) return;
    lastPeriodicAt = now;
    enqueueSave({ refreshScrollback: true, periodic: true });
  }, SCROLLBACK_REFRESH_MS);

  // Sin listener de onCloseRequested a propósito: en Tauri 2, registrar uno
  // intercepta el cierre nativo de la ventana hasta que el JS responda, y eso
  // es justo lo que rompía el botón de cerrar. El cierre lo frena Rust y lo guarda
  // `saveForClose` con su barra de progreso (ver `app/closeWithSave.ts`).
}
