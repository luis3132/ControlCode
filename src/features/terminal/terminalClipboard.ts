import type { Terminal } from "@xterm/xterm";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { TerminalClipboard } from "./terminalKeys";

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * El portapapeles de una terminal: copiar lo seleccionado y pegar con `term.paste`.
 *
 * Por el plugin de Tauri y no por `navigator.clipboard`: leer desde el webview no anda
 * igual en los tres motores (en macOS pregunta cada vez con un globo de "Pegar"), y el
 * plugin habla con el portapapeles del sistema, Wayland incluido.
 *
 * `term.paste` y no escribir al PTY: respeta el *bracketed paste* que pidió la TUI, así un
 * texto de varias líneas llega como un pegado y no como varios Enter.
 */
export function terminalClipboard(term: Terminal): TerminalClipboard {
  return {
    isMac: IS_MAC,
    hasSelection: () => term.hasSelection(),
    copy: (clear) => {
      const text = term.getSelection();
      if (!text) return;
      writeText(text).catch(console.error);
      if (clear) term.clearSelection();
    },
    paste: () => {
      readText()
        .then((text) => { if (text) term.paste(text); })
        .catch(console.error);
    },
  };
}
