import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Modal, Progress } from "neogestify-ui-components";

import i18n from "@/i18n";
import { saveForClose, type SaveStep } from "@/features/tabs/persistence";
import { useTabsStore } from "@/features/tabs/store";
import { ptyKill } from "@/features/terminal/ipc";
import { closeAndForgetWindow, confirmExitAll } from "@/shared/ipc/window";

/**
 * Cerrar guardando antes, con una alerta que muestra cuánto falta.
 *
 * El 100% es TODO lo que hay que guardar, contado antes de empezar:
 *
 * - por cada ventana: su posición, el scrollback de cada terminal (leído en ese momento) y
 *   la escritura en la base (ver `saveForClose`);
 * - si con esto se cierra la app: las cookies y el storage del navegador que todavía no
 *   llegaron a disco, sitio por sitio;
 * - cerrar cada terminal de la ventana: matar al agente y a lo que haya lanzado, y esperar
 *   a que termine. Es lo que más tarda, y antes pasaba DESPUÉS de la alerta (en la salida
 *   de Rust, `kill_all_sessions`), con la ventana congelada en pantalla.
 *
 * Cada paso suma cuando TERMINA. Nada es tiempo estimado. Y el diálogo no se cierra al
 * llegar al 100%: queda puesto hasta que la ventana desaparece.
 */

/** Pasado esto se cierra igual: un guardado colgado no puede dejar la app sin cerrarse. */
const SAVE_TIMEOUT_MS = 20_000;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

type Step = SaveStep
  | { kind: "site"; origin: string }
  | { kind: "window"; label: string }
  | { kind: "kill"; title: string }
  | { kind: "closing" };

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "start": return t("app.saving.start");
    case "bounds": return t("app.saving.bounds");
    case "terminal": return t("app.saving.terminal", { name: step.title });
    case "write": return t("app.saving.write");
    case "site": return t("app.saving.site", { site: step.origin.replace(/^https?:\/\//, "") });
    case "window": return t("app.saving.window", { label: step.label });
    case "kill": return t("app.saving.kill", { name: step.title });
    case "closing": return t("app.saving.closing");
  }
}

interface ClosingState {
  open: boolean;
  done: number;
  /** 0 = todavía no se sabe cuánto hay (otras ventanas no contestaron). */
  total: number;
  label: string;
}

const useClosingStore = create<ClosingState>()(() => ({ open: false, done: 0, total: 0, label: "" }));

/** El progreso del cierre. Lo mueven las funciones de este archivo; se ve con
 *  `<ClosingProgress />`, montado en todas las ventanas (ver `AppExitListener`). */
class SaveAlert {
  open() {
    useClosingStore.setState({ open: true, done: 0, total: 0, label: t("app.saving.start") });
  }

  render(done: number, total: number, label: string) {
    useClosingStore.setState({ done, total, label });
  }

  close() {
    useClosingStore.setState({ open: false });
  }
}

/**
 * El diálogo de "guardando antes de cerrar": el `Modal` de neogestify con su `Progress`.
 * No se puede cerrar —ni X, ni Esc, ni click afuera—: se va con la ventana.
 */
export function ClosingProgress() {
  const { open, done, total, label } = useClosingStore();
  if (!open) return null;
  const value = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Modal
      title={t("app.saving.title")}
      onClose={() => {}}
      size="sm"
      showCloseButton={false}
      closeOnBackdrop={false}
      closeOnEsc={false}
    >
      <div className="flex flex-col gap-2">
        <Progress
          value={value}
          indeterminate={total === 0}
          showValue={total > 0}
          label={total > 0 ? t("app.saving.count", { done, total }) : t("app.saving.counting")}
        />
        <span className="truncate text-[12px] text-gray-500 dark:text-white/45">{label}</span>
      </div>
    </Modal>
  );
}

function withTimeout(work: Promise<void>): Promise<void> {
  return Promise.race([work, new Promise<void>((r) => setTimeout(r, SAVE_TIMEOUT_MS))]);
}

/** Los sitios del navegador con cambios sin escribir. Solo al cerrar la app: mientras
 *  queda otra ventana, los proxies siguen vivos y su guardador los escribe solo. */
async function unsavedSites(): Promise<string[]> {
  return invoke<string[]>("preview_unsaved_sites").catch(() => []);
}

async function saveSites(sites: string[], onDone: (origin: string) => void) {
  for (const origin of sites) {
    await invoke("preview_save_site", { origin }).catch(console.error);
    onDone(origin);
  }
}

/** Las terminales de esta ventana, para cerrarlas como pasos del progreso. */
function windowTerminals(): { ptyId: number; title: string }[] {
  return useTabsStore.getState().tabs
    .filter((tab) => tab.ptyId != null)
    .map((tab) => ({ ptyId: tab.ptyId as number, title: tab.title }));
}

/** Cierra las terminales en paralelo; cada una suma cuando su proceso ya terminó. */
async function killTerminals(terms: { ptyId: number; title: string }[], onDone: (title: string) => void) {
  await Promise.all(terms.map((term) =>
    ptyKill(term.ptyId).catch(console.error).finally(() => onDone(term.title))));
}

let closing = false;

/**
 * Guarda esta ventana, cierra sus terminales y la cierra.
 *
 * - `button`: el botón de cerrar o "cerrar solo esta" — la fila se olvida si el workspace
 *   tiene otras ventanas vivas (ver `close_and_forget_window`).
 * - `system`: Alt+F4, Cmd+Q, el gestor de ventanas — la fila queda como la dejaba el
 *   cierre del sistema.
 */
export async function closeWindowWithSave(mode: "button" | "system"): Promise<void> {
  if (closing) return;
  closing = true;
  const win = getCurrentWindow();
  const alert = new SaveAlert();
  alert.open();
  try {
    const last = (await getAllWebviewWindows().catch(() => [])).length <= 1;
    const sites = last ? await unsavedSites() : [];
    const terms = windowTerminals();
    const extra = sites.length + terms.length;
    let total = 0;
    let done = 0;
    const tick = (step: Step) => alert.render(++done, total, stepLabel(step));
    await withTimeout((async () => {
      await saveForClose((d, windowTotal, step) => {
        done = d;
        total = windowTotal + extra;
        alert.render(done, total, stepLabel(step));
      });
      await saveSites(sites, (origin) => tick({ kind: "site", origin }));
      await killTerminals(terms, (title) => tick({ kind: "kill", title }));
    })());
    alert.render(total, total, stepLabel({ kind: "closing" }));
  } catch (e) {
    console.error("[close] no se pudo guardar todo antes de cerrar", e);
  }
  // La alerta NO se cierra: se va con la ventana. Si cerrar falla, sí, para no dejar la
  // ventana tapada.
  const closed = mode === "button"
    ? closeAndForgetWindow(win.label)
    : invoke("close_window_saved", { label: win.label });
  await closed.catch((e) => {
    console.error(e);
    alert.close();
    closing = false;
  });
}

interface SaveAllProgress {
  id: string;
  label: string;
  done: number;
  total: number;
  step: string;
}

/**
 * "Cerrar todo": cada ventana guarda lo suyo (cada una tiene su propio estado de tabs y
 * sus terminales) y le va contando a esta cuánto lleva; al final se escriben los sitios
 * del navegador y se sale.
 */
export async function exitAllWithSave(): Promise<void> {
  if (closing) return;
  closing = true;
  const alert = new SaveAlert();
  alert.open();
  const id = crypto.randomUUID();
  const labels = (await getAllWebviewWindows().catch(() => [])).map((w) => w.label);
  const state = new Map<string, { done: number; total: number }>();
  let lastStep = t("app.saving.start");

  try {
    const sites = await unsavedSites();
    let sitesDone = 0;
    const redraw = () => {
      const known = labels.every((l) => state.has(l));
      let done = sitesDone;
      let total = sites.length;
      for (const s of state.values()) { done += s.done; total += s.total; }
      alert.render(done, known ? total : 0, lastStep);
    };

    await withTimeout(new Promise<void>((resolve) => {
      const allDone = () => labels.every((l) => {
        const s = state.get(l);
        return s !== undefined && s.done >= s.total;
      });
      const unlisten = listen<SaveAllProgress>("cc-save-progress", (e) => {
        if (e.payload.id !== id) return;
        state.set(e.payload.label, { done: e.payload.done, total: e.payload.total });
        lastStep = labels.length > 1
          ? `${t("app.saving.window", { label: e.payload.label })} · ${e.payload.step}`
          : e.payload.step;
        redraw();
        if (allDone()) {
          unlisten.then((fn) => fn());
          resolve();
        }
      });
      unlisten.then(() => emit("cc-save-all", { id }));
    }));

    await withTimeout(saveSites(sites, (origin) => {
      sitesDone += 1;
      lastStep = stepLabel({ kind: "site", origin });
      redraw();
    }));
    lastStep = stepLabel({ kind: "closing" });
    redraw();
  } catch (e) {
    console.error("[close] no se pudo guardar todo antes de salir", e);
  }
  // Como en `closeWindowWithSave`: la alerta se va con la app.
  await confirmExitAll().catch((e) => {
    console.error(e);
    alert.close();
    closing = false;
  });
}

/**
 * Lo que cada ventana escucha para el cierre:
 *
 * - `cc-close-requested` (de Rust, con la etiqueta): el sistema quiere cerrar esta ventana.
 * - `cc-save-all` (de otra ventana, o de esta): guardar lo propio e ir contando.
 */
export function installCloseListeners(): () => void {
  const label = getCurrentWindow().label;
  const offs = [
    listen<string>("cc-close-requested", (e) => {
      if (e.payload === label) closeWindowWithSave("system");
    }),
    listen<{ id: string }>("cc-save-all", async (e) => {
      const { id } = e.payload;
      // Cada ventana guarda lo suyo y cierra sus terminales; los dos cuentan en su total.
      const terms = windowTerminals();
      let done = 0;
      let total = 0;
      const report = (step: Step) =>
        emit("cc-save-progress", { id, label, done, total, step: stepLabel(step) } satisfies SaveAllProgress);
      await saveForClose((d, windowTotal, step) => {
        done = d;
        total = windowTotal + terms.length;
        report(step);
      }).catch(console.error);
      await killTerminals(terms, (title) => { done += 1; report({ kind: "kill", title }); });
    }),
  ];
  return () => { for (const off of offs) off.then((fn) => fn()); };
}
