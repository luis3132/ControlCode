import { invoke } from "@tauri-apps/api/core";

/** Lo que devuelve `tab_browser_mcp` (ver `src-tauri/src/ipc/mcp.rs`). */
export interface TabMcp {
  configPath: string;
  allowedTools: string[];
}

const quote = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`);

/**
 * El comando de una tab de Claude Code con el navegador de la app enchufado: su
 * `--mcp-config` y las tools del navegador ya permitidas.
 *
 * Va al final a propósito: `--mcp-config` y `--allowedTools` aceptan varios valores, y
 * cualquier argumento suelto que viniera después se lo tragarían como si fuera suyo.
 */
export function appendBrowserMcp(command: string, mcp: TabMcp): string {
  // Un comando que ya lo trae (una tab reabierta con el comando ya armado) no lo duplica.
  if (command.includes(mcp.configPath)) return command;
  return `${command} --mcp-config ${quote(mcp.configPath)} --allowedTools ${quote(mcp.allowedTools.join(","))}`;
}

/**
 * Lo mismo, pidiéndole a la app el config de esta carpeta. Si no se puede (una build sin
 * `ccode`), la tab arranca como siempre: el navegador es un agregado, no una condición.
 */
export async function withBrowserMcp(command: string, cwd: string): Promise<string> {
  try {
    const mcp = await invoke<TabMcp | null>("tab_browser_mcp", { cwd });
    return mcp ? appendBrowserMcp(command, mcp) : command;
  } catch {
    return command;
  }
}
