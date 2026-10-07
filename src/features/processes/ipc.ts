/** Comandos de los subprocesos. Ver `src-tauri/src/procs/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { ProcUsage, Subprocess } from "./types";

export const procsList = () => invoke<Subprocess[]>("procs_list");
export const procsStart = (command: string, cwd: string, name: string | null) =>
  invoke<Subprocess>("procs_start", { command, cwd, name });
/** Sin `force`: Ctrl-C y, si en unos segundos no se fue, lo mata con toda su descendencia. */
export const procsStop = (id: string, force: boolean) => invoke<Subprocess>("procs_stop", { id, force });
export const procsRestart = (id: string) => invoke<Subprocess>("procs_restart", { id });
/** Olvida los terminados: uno, o todos sin `id`. */
export const procsClear = (id: string | null) => invoke<number>("procs_clear", { id });
export const procsUsage = () => invoke<ProcUsage[]>("procs_usage");

/** El evento que manda Rust cuando la lista cambia (`procs::CHANGED`). */
export const PROCS_CHANGED = "cc-procs-changed";
