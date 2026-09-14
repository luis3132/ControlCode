import type { Terminal } from "@xterm/xterm";

/**
 * Las terminales vivas, por tab. Es la puerta para escribirle a un agente desde otra parte
 * de la app (hoy, el navegador que le manda elementos marcados).
 *
 * Se pega a través de xterm y no escribiendo directo al PTY: `paste()` sabe si la TUI pidió
 * *bracketed paste* y envuelve el texto como corresponde. Escribiendo crudo, cada salto de
 * línea de un mensaje de varias líneas llegaría como un Enter y lo mandaría a medias.
 */
const terminals = new Map<string, Terminal>();

export function registerTerminal(tabId: string, term: Terminal): () => void {
  terminals.set(tabId, term);
  return () => {
    if (terminals.get(tabId) === term) terminals.delete(tabId);
  };
}

/** Pega `text` en la terminal de la tab y, con `submit`, lo manda. `false` si la tab no
 *  tiene una terminal viva. */
export function pasteIntoTab(tabId: string, text: string, submit: boolean): boolean {
  const term = terminals.get(tabId);
  if (!term) return false;
  term.paste(text);
  // El Enter va aparte y un momento después: algunas TUIs todavía están procesando el
  // pegado cuando llega, y lo toman como parte de él en vez de como "enviar".
  if (submit) setTimeout(() => term.input("\r"), 80);
  return true;
}
