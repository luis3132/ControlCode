/**
 * El foco de la persona mientras un agente usa el navegador.
 *
 * El runtime de la página ya no llama a `focus()` si la persona no está en ella (ver
 * `agentFocus` en `page/runtime.ts`), pero la página puede hacerlo sola: un `autofocus`
 * después de navegar, un modal que enfoca su primer campo al abrirse. En WebKitGTK eso le
 * pasa el foco de la app entera al `<iframe>`, y quien estaba tipeando en una terminal
 * sigue tipeando… en la página. Acá se anota qué tenía el foco antes de la acción y se lo
 * devuelve al terminar, y un rato después por lo que la página haga tarde.
 */

let acting = 0;

/** Un agente está actuando en algún navegador: un `blur` de la ventana no es un click de
 *  la persona en la página (ver `ViewTabsHost`). */
export const agentIsActing = (): boolean => acting > 0;

/** Lo que la página hace tarde (animaciones, `settle`, handlers con timers). */
const LATE_MS = 400;

export async function keepUserFocus<T>(run: () => Promise<T>): Promise<T> {
  const before = document.activeElement;
  const restore = () => {
    const now = document.activeElement;
    if (now === before || now?.tagName !== "IFRAME") return;
    if (before instanceof HTMLElement && before.isConnected && before.tagName !== "IFRAME" && before !== document.body) {
      before.focus({ preventScroll: true });
    }
  };
  acting++;
  try {
    return await run();
  } finally {
    restore();
    setTimeout(() => {
      restore();
      acting--;
    }, LATE_MS);
  }
}
