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

/** Scrollback acumulado de un PTY vivo — reconectarse a él no lo reinicia. */
export const ptyAttach = (id: number) => invoke<string>("pty_attach", { id });

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
