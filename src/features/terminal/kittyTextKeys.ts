import type { Terminal } from "@xterm/xterm";

/**
 * Los acentos con tecla muerta, cuando la TUI activó el protocolo de teclado de Kitty.
 *
 * ## El bug
 *
 * Con el modo "reportar todas las teclas como secuencias" (flag 8), xterm 6.1 convierte
 * cada tecla en `CSI código u` y cancela el keydown. Para una letra normal está bien. Pero
 * después de una tecla muerta —el ´ de un teclado en español— xterm marca la siguiente
 * tecla como "carácter compuesto pendiente" y no la envía por el keydown, contando con que
 * llegue por `keypress`… que ya no llega, porque el keydown quedó cancelado. La "á"
 * desaparece. Reproducido con la beta instalada: `´` + `a` no manda ningún byte, mientras
 * que `a` sola manda `ESC[97u`.
 *
 * ## El arreglo
 *
 * El carácter que sigue a una tecla muerta no pasa por el keydown de xterm: sigue el
 * camino de `keypress`, que lo manda como texto. Es exactamente lo que xterm hace sin el
 * protocolo, y lo que hace la propia terminal Kitty con el texto compuesto: las teclas se
 * reportan como secuencias, el texto se manda como texto.
 *
 * No hace falta saber qué flags pidió la TUI: en los modos donde xterm ya lo manejaba bien
 * (sin protocolo, o con los flags 1/2/4), el resultado de desviarlo es el mismo.
 *
 * Lo que compone por IME (macOS, y Linux cuando WebKitGTK usa composición) no entra acá:
 * esos eventos vienen marcados como composición y xterm los resuelve por su lado.
 */

/** Las teclas que pueden ir entre la tecla muerta y la letra sin romper la composición:
 *  `´` + Shift + `a` es "Á". */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "OS"]);

type KeyLike = Pick<KeyboardEvent, "type" | "key" | "keyCode" | "isComposing">;

/**
 * Decide, evento por evento, si xterm debe procesar el keydown (`true`) o dejarlo pasar
 * como texto (`false`). Es la forma que espera `attachCustomKeyEventHandler`.
 */
export function createDeadKeyFilter(): (event: KeyLike) => boolean {
  let deadPending = false;

  return (event) => {
    if (event.type !== "keydown") return true;
    // Composición por IME: la tecla muerta la resolvió el IME y lo maneja xterm. Olvidarla
    // evita desviar después una letra cualquiera que ya no compone con nada.
    if (event.isComposing || event.keyCode === 229) {
      deadPending = false;
      return true;
    }

    if (event.key === "Dead") {
      deadPending = true;
      return true;
    }
    if (MODIFIERS.has(event.key)) return true;

    if (!deadPending) return true;
    deadPending = false;
    // Un carácter (contando por puntos de código, no por unidades UTF-16) es el texto
    // compuesto. Una flecha o un Escape después de la tecla muerta siguen su camino normal.
    return [...event.key].length !== 1;
  };
}

export function installDeadKeyFilter(term: Terminal): void {
  term.attachCustomKeyEventHandler(createDeadKeyFilter());
}
