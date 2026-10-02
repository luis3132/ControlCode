/**
 * Soltar archivos sobre la terminal de un agente: desde el árbol de la app o desde el
 * gestor de archivos del sistema. Lo que llega es la mención (`@src/a.ts`), escrita en su
 * entrada y sin mandar: el archivo es el tema, la pregunta la escribe la persona.
 */
import { create } from "zustand";

import { dropText } from "@/features/explorer/paths";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { focusTab, pasteIntoTab } from "./terminalRegistry";

/** El atributo que marca el contenedor de la terminal de cada tab (ver `TerminalPanel`). */
export const TERMINAL_TAB_ATTR = "data-terminal-tab";

/** La terminal sobre la que se está arrastrando algo ahora, para resaltarla. */
export const useFileDropTarget = create<{ tabId: string | null }>(() => ({ tabId: null }));
export const setFileDropTarget = (tabId: string | null) => {
  if (useFileDropTarget.getState().tabId !== tabId) useFileDropTarget.setState({ tabId });
};

/** La tab cuya terminal está bajo ese punto, en px CSS. `null` = no hay una a la vista. */
export function terminalTabAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${TERMINAL_TAB_ATTR}]`);
  return el?.getAttribute(TERMINAL_TAB_ATTR) ?? null;
}

/** Escribe los archivos en la terminal de la tab y le da el foco. `false` = no tiene una
 *  terminal viva, y lo que se pegara se perdería. */
export function dropFilesOnTab(tabId: string, files: { path: string; isDir: boolean }[]): boolean {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const text = dropText(files, tab.cwd, tab.agentId === SHELL_AGENT_ID);
  if (!text || !pasteIntoTab(tabId, text, false)) return false;
  useTabsStore.getState().activateTab(tabId);
  useViewTabsStore.getState().showTerminal();
  focusTab(tabId);
  return true;
}
