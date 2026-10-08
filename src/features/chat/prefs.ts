/**
 * El modelo y el modo de permisos de cada tab en modo HTML. Son preferencias de la persona
 * para esa tab, no estado de la conversación: van en `localStorage` y no en la base.
 */
import { EFFORTS, type Effort, type PermissionMode } from "./types";

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

/**
 * El esfuerzo se recuerda por tab **y por modelo**: no es una preferencia suelta, es cuánto
 * querés que piense ESE modelo. Opus en alto y Haiku en bajo es una combinación razonable,
 * y con una sola preferencia cambiar de modelo te pisaba la otra.
 */
const effortKey = (tabId: string, model: string | null) => `cc-chat-effort:${tabId}:${model ?? "default"}`;

export function loadEffort(tabId: string, model: string | null): Effort | null {
  const v = read(effortKey(tabId, model));
  return EFFORTS.includes(v as Effort) ? (v as Effort) : null;
}
export const saveEffort = (tabId: string, model: string | null, effort: Effort | null) =>
  write(effortKey(tabId, model), effort);

/**
 * Los modelos que se vieron de verdad en esta carpeta, por nombre completo
 * (`claude-opus-5-5`). Es lo que hace que el selector no haya que tocarlo cada vez que sale
 * un modelo nuevo: el `init` de cada sesión dice con cuál corrió, y de ahí sale la lista.
 */
export function loadSeenModels(cwd: string): string[] {
  try {
    const v = JSON.parse(read(`cc-chat-models:${cwd}`) ?? "null");
    if (Array.isArray(v)) return v.filter((m): m is string => typeof m === "string");
  } catch {
    // ilegible: como si no hubiera
  }
  return [];
}

/** Agrega uno a la lista (al principio, sin repetir) y devuelve la lista nueva. */
export function rememberModel(cwd: string, model: string): string[] {
  const seen = loadSeenModels(cwd);
  if (seen.includes(model)) return seen;
  const next = [model, ...seen].slice(0, 12);
  write(`cc-chat-models:${cwd}`, JSON.stringify(next));
  return next;
}

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
