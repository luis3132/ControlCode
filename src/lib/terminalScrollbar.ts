import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Mantiene visible la barra de scroll de la terminal cuando hay historial que recorrer.
 *
 * ## Por qué hace falta
 *
 * xterm 6 no usa la barra nativa del navegador: dibuja una propia (la de VS Code) en modo
 * `Auto`, que solo aparece mientras el puntero está encima o mientras se está scrolleando.
 * Con el fondo oscuro de la terminal y el color por defecto (el del texto al 20%), en la
 * práctica es invisible: no se ve que haya historial ni de dónde agarrarlo.
 *
 * ## Por qué no se fuerza a secas
 *
 * La tentación es `opacity: 1` sobre la barra y listo. No sirve: cuando NO hay nada que
 * scrollear, xterm igual dibuja el pulgar del alto completo del riel (no lo achica a cero),
 * así que forzarla deja una barra llena y falsa en toda terminal recién abierta.
 *
 * Por eso la condición se decide acá, con el dato que solo conoce la terminal:
 * `baseY > 0` significa que ya hay líneas fuera de la pantalla. Y como en la pantalla
 * alternativa (OpenCode y otras TUIs) no hay scrollback, `baseY` es siempre 0 y la barra
 * vuelve sola a su comportamiento normal — que es lo correcto: ahí no hay nada que recorrer.
 */
export const SCROLLABLE_CLASS = "cc-term-scrollable";

export function keepScrollbarVisible(term: Terminal, container: HTMLElement): () => void {
  const update = () => {
    container.classList.toggle(SCROLLABLE_CLASS, term.buffer.active.baseY > 0);
  };

  const subs: IDisposable[] = [
    // `onLineFeed`: el momento exacto en que una línea empieza a salirse de pantalla.
    term.onLineFeed(update),
    // `onScroll` cubre el salto entre pantalla normal y alternativa, y el clear.
    term.onScroll(update),
    // Achicar la ventana puede volver scrolleable algo que no lo era.
    term.onResize(update),
  ];

  update();

  return () => {
    for (const sub of subs) sub.dispose();
    container.classList.remove(SCROLLABLE_CLASS);
  };
}
