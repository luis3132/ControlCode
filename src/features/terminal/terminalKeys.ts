import type { Terminal } from "@xterm/xterm";

import { keyName } from "@/shared/keyboard";

/**
 * Lo que la terminal decide sobre el teclado ANTES que xterm.
 *
 * ## Tab no saca el foco de la terminal
 *
 * Tab y Shift+Tab son teclas de la TUI (autocompletar, cambiar de modo en Claude Code), no
 * de la ventana. Si el navegador llega a verlas, mueve el foco al siguiente control de la
 * app y todo lo que se tipea después le llega a otro lado. Acá se cancelan siempre. Ctrl+Tab
 * no, que es el atajo de la app para cambiar de tab.
 *
 * En Linux Shift+Tab además llega mal: WebKitGTK lo reporta como `key: "Unidentified"` (ver
 * `keyName`). xterm reconoce las teclas por `key`, así que con el protocolo de Kitty no la
 * mandaba ni la cancelaba, y WebKit movía el foco hacia atrás. No se puede corregir el
 * evento —sus propiedades son de solo lectura—: se cancela y se le entrega a xterm uno
 * nuevo que dice Tab, con los mismos modificadores.
 *
 * El otro caso en que xterm no cancelaba Tab es el de la sección siguiente.
 *
 * ## AltGr y las teclas muertas no le llegan a xterm
 *
 * Cuando xterm ve un keydown de "Dead" o de "AltGraph" se marca que viene un carácter
 * compuesto, y a la próxima tecla que produce algo NO la manda por el keydown: espera que
 * llegue por `keypress`. Si esa próxima tecla no genera `keypress` —AltGr apretado y
 * soltado solo, o una composición que resolvió el IME—, la marca queda puesta y se come
 * lo siguiente que se tipee: un Tab, un Enter, una flecha. Con el protocolo de Kitty
 * (Claude Code y OpenCode lo usan) encima no cancela el evento, y el Tab se va de la
 * terminal. Reproducido con xterm 6.1: AltGr suelto y después Tab no manda nada y deja
 * pasar el evento al navegador.
 *
 * Ninguna de las dos teclas produce nada por sí sola, así que xterm no pierde nada por no
 * verlas: sin la marca, el carácter de AltGr (`@`, `#`, `[`) sale por el keydown como
 * cualquier otro. En Windows AltGr llega como Ctrl+Alt y xterm lo reconoce por su lado.
 *
 * ## El carácter que sigue a una tecla muerta va como texto
 *
 * Con el modo "reportar todas las teclas como secuencias" (flag 8 de Kitty), xterm
 * convierte la "á" que sigue a la tecla muerta en `CSI código u` y la letra compuesta se
 * pierde. Ese carácter se desvía al camino de `keypress`, que lo manda como texto: lo
 * mismo que xterm hace sin el protocolo y lo que hace la propia Kitty con el texto
 * compuesto. No hace falta saber qué flags pidió la TUI: en los demás modos el resultado
 * es el mismo.
 *
 * Lo que compone por IME (macOS, y Linux cuando el IME resuelve la tecla muerta) llega
 * marcado como composición y lo resuelve xterm por su lado.
 */

/** Las teclas que pueden ir entre la tecla muerta y la letra sin romper la composición:
 *  `´` + Shift + `a` es "Á". */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "OS"]);

/** Teclas que no producen nada solas y que, vistas por xterm, dejan una marca colgada. */
const COMPOSE_KEYS = new Set(["Dead", "AltGraph"]);

type KeyLike = Pick<
  KeyboardEvent,
  | "type" | "key" | "code" | "keyCode" | "isComposing" | "repeat"
  | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "preventDefault"
>;

/** Cómo entregarle a xterm un keydown corregido. */
export type Redispatch = (init: KeyboardEventInit) => void;

/**
 * Decide, evento por evento, si xterm procesa la tecla (`true`) o no (`false`). Es la
 * forma que espera `attachCustomKeyEventHandler`.
 */
export function createTerminalKeyHandler(redispatch: Redispatch): (event: KeyLike) => boolean {
  let deadPending = false;

  return (event) => {
    // El soltar de una tecla que xterm no vio apretarse tampoco le sirve.
    if (event.type === "keyup") return !COMPOSE_KEYS.has(event.key);
    if (event.type !== "keydown") return true;

    if (keyName(event) === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (event.key !== "Tab" && !event.isComposing) {
        redispatch({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: event.shiftKey, repeat: event.repeat });
        return false;
      }
    }

    // Composición por IME: la tecla muerta la resolvió el IME y lo maneja xterm. Olvidarla
    // evita desviar después una letra cualquiera que ya no compone con nada.
    if (event.isComposing || event.keyCode === 229) {
      deadPending = false;
      return true;
    }

    if (COMPOSE_KEYS.has(event.key)) {
      if (event.key === "Dead") deadPending = true;
      return false;
    }
    if (MODIFIERS.has(event.key)) return true;

    if (!deadPending) return true;
    deadPending = false;
    // Un carácter (contando por puntos de código, no por unidades UTF-16) es el texto
    // compuesto. Una flecha o un Escape después de la tecla muerta siguen su camino normal.
    return [...event.key].length !== 1;
  };
}

export function installTerminalKeyHandler(term: Terminal): void {
  // xterm escucha el keydown en su textarea: el evento corregido entra por el mismo lugar
  // que uno de verdad. `keyCode` va porque sin protocolo de Kitty xterm reconoce Tab por él.
  const redispatch: Redispatch = (init) => {
    term.textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  };
  term.attachCustomKeyEventHandler(createTerminalKeyHandler(redispatch));
}
