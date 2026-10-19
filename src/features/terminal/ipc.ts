/** Comandos del PTY. Ver `terminal/pty_manager.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface PtyCreateArgs {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Variables extra para ESTE proceso; `null` = ninguna (ver `pty_create` en Rust). */
  env: Record<string, string> | null;
  /** Comandos ya resueltos a ejecutar antes del agente. */
  prelaunch: string[];
}

/** Lanza el proceso y devuelve el id del PTY. El tamaño se fija acá, al nacer. */
export const ptyCreate = (args: PtyCreateArgs) => invoke<number>("pty_create", { ...args });

/** Scrollback acumulado de un PTY — reconectarse a él no lo reinicia. `exitCode` no es
 *  `null` si el proceso ya terminó (su buffer vive hasta que se cierra la tab). */
export const ptyAttach = (id: number) =>
  invoke<{ data: string; total: number; exitCode: number | null }>("pty_attach", { id });

/** Cuánto escribió en total cada PTY, sin copiar nada. Las claves llegan como texto. */
export const ptyOutputTotals = (ids: number[]) =>
  invoke<Record<string, number>>("pty_output_totals", { ids });

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
/** La carpeta donde está parado ahora el shell. `null` = no se sabe desde afuera (Windows). */
export const ptyCwd = (id: number) => invoke<string | null>("pty_cwd", { id });
