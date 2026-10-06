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

/** Las terminales que ya están conectadas a su PTY: antes de eso, lo que se pegue no
 *  llega a ningún proceso (xterm lo manda por `onData` y todavía no hay a quién). */
const attached = new Set<string>();

/** Lo que se pegó a una terminal que todavía no podía recibirlo (hibernada, o recién
 *  montada y conectándose): sale cuando se conecta. */
const pendingPastes = new Map<string, { text: string; submit: boolean }[]>();

/** Despierta una tab hibernada. Lo instala `TerminalPanel`, que es quien las monta. */
let waker: ((tabId: string) => boolean) | null = null;
export function setTerminalWaker(fn: ((tabId: string) => boolean) | null) {
  waker = fn;
}

/** Mensajes para agentes que todavía no terminaron de arrancar. */
const queued = new Map<string, string>();

/** Cuánto tiene que estar callada la terminal para dar por hecho que la TUI ya arrancó y
 *  espera que le escriban. Los comandos previos y el arranque imprimen en ráfagas. */
const SETTLE_MS = 2500;
/** Si nunca llega a quedarse quieta (una TUI con reloj en pantalla), se manda igual. */
const GIVE_UP_MS = 45_000;

/** Espera a que la TUI termine de arrancar y le manda `text`. */
function sendWhenSettled(tabId: string, term: Terminal, text: string): void {
  let timer: number | undefined;
  let sawOutput = false;
  const send = () => {
    sub.dispose();
    window.clearTimeout(timer);
    window.clearTimeout(giveUp);
    if (terminals.get(tabId) !== term) return;
    queued.delete(tabId);
    pasteIntoTab(tabId, text, true);
  };
  const sub = term.onWriteParsed(() => {
    sawOutput = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(send, SETTLE_MS);
  });
  const giveUp = window.setTimeout(() => { if (sawOutput) send(); else sub.dispose(); }, GIVE_UP_MS);
}

/**
 * Deja un mensaje para el agente de `tabId`, que se envía cuando su TUI termina de
 * arrancar. Es para una tab recién abierta: pegar antes le escribiría al shell de los
 * comandos previos, o a una TUI que todavía no dibujó su entrada y lo tira.
 *
 * Ninguna de las TUIs tiene un flag común para "arrancá con este mensaje", así que se
 * espera a que la terminal se quede quieta, que es cuando la persona empezaría a escribir.
 */
export function sendWhenReady(tabId: string, text: string): void {
  queued.set(tabId, text);
  const term = terminals.get(tabId);
  if (term) sendWhenSettled(tabId, term, text);
}

export function registerTerminal(tabId: string, term: Terminal): () => void {
  terminals.set(tabId, term);
  const pending = queued.get(tabId);
  if (pending !== undefined) sendWhenSettled(tabId, term, pending);
  return () => {
    if (terminals.get(tabId) === term) {
      terminals.delete(tabId);
      attached.delete(tabId);
    }
  };
}

/** La terminal de la tab ya está conectada a su PTY: sale lo que se le pegó mientras tanto. */
export function terminalAttached(tabId: string): void {
  attached.add(tabId);
  const pending = pendingPastes.get(tabId);
  pendingPastes.delete(tabId);
  pending?.forEach(({ text, submit }) => pasteIntoTab(tabId, text, submit));
}

/** Pega `text` en la terminal de la tab y, con `submit`, lo manda. `false` si la tab no
 *  tiene una terminal viva. */
export function pasteIntoTab(tabId: string, text: string, submit: boolean): boolean {
  const term = terminals.get(tabId);
  if (!term || !attached.has(tabId)) {
    // Hibernada: se despierta y lo pegado sale apenas se reconecta. Montada pero todavía
    // conectándose: espera lo mismo.
    if (term || waker?.(tabId)) {
      pendingPastes.set(tabId, [...(pendingPastes.get(tabId) ?? []), { text, submit }]);
      return true;
    }
    return false;
  }
  term.paste(text);
  // El Enter va aparte y un momento después: algunas TUIs todavía están procesando el
  // pegado cuando llega, y lo toman como parte de él en vez de como "enviar".
  if (submit) setTimeout(() => term.input("\r"), 80);
  return true;
}

/** Le da el foco a la terminal de la tab, para seguir escribiendo en lo que se pegó. */
export function focusTab(tabId: string): void {
  terminals.get(tabId)?.focus();
}
