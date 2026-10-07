/**
 * El modelo y el modo de permisos de cada tab en modo HTML. Son preferencias de la persona
 * para esa tab, no estado de la conversación: van en `localStorage` y no en la base.
 */
import type { PermissionMode } from "./types";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sin storage (modo privado, cuota): la preferencia dura lo que dure la tab.
  }
}

export const loadModel = (tabId: string) => read(`cc-chat-model:${tabId}`);
export const saveModel = (tabId: string, model: string | null) => write(`cc-chat-model:${tabId}`, model);

export function loadMode(tabId: string): PermissionMode {
  const v = read(`cc-chat-mode:${tabId}`);
  return MODES.includes(v as PermissionMode) ? (v as PermissionMode) : "default";
}
export const saveMode = (tabId: string, mode: PermissionMode) => write(`cc-chat-mode:${tabId}`, mode);

/** Los comandos de `/` del último arranque en esta carpeta: así el menú tiene qué mostrar
 *  antes del primer mensaje, que es cuando la CLI los dice. */
export function loadCommands(cwd: string): { slash: string[]; terminal: string[] } {
  try {
    const v = JSON.parse(read(`cc-chat-commands:${cwd}`) ?? "null");
    if (v && Array.isArray(v.slash) && Array.isArray(v.terminal)) return v;
  } catch {
    // ilegible: como si no hubiera
  }
  return { slash: [], terminal: [] };
}
export const saveCommands = (cwd: string, slash: string[], terminal: string[]) =>
  write(`cc-chat-commands:${cwd}`, JSON.stringify({ slash, terminal }));
