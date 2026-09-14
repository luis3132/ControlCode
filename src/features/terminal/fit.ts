import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Ajustar la grilla de la terminal al tamaño real del contenedor.
 *
 * ## El contenedor no puede tener padding
 *
 * `fit()` mide el PADRE del elemento de xterm con `getComputedStyle(...).height/width`, y
 * con `box-sizing: border-box` eso incluye el padding. La terminal tenía 8px de padding
 * en ese mismo padre, así que fit calculaba filas y columnas para 16px más de los que había:
 * sobraba casi una fila (se recortaba a mano) y un par de columnas que nadie recortaba —
 * el borde derecho de la TUI quedaba cortado. Por eso el padding vive ahora en un
 * envoltorio de afuera (ver `Terminal.tsx`) y el padre de xterm mide exactamente lo
 * disponible.
 *
 * ## El redondeo del motor
 *
 * Aun con la cuenta bien hecha, lo que se rasteriza no siempre mide lo teórico: con
 * escalado fraccionario cada celda se redondea a píxeles de dispositivo y el error se
 * acumula. En vez de predecirlo, se compara lo que xterm dice que ocupa (`dimensions`, API
 * pública desde 6.1) con el espacio real y, si se pasa, se saca una fila o una columna.
 */
export function createFitter(term: XTerm, addon: FitAddon, container: () => HTMLElement | null) {
  const trimOverflow = () => {
    const el = container();
    const canvas = term.dimensions?.css.canvas;
    if (!el || !canvas) return;
    const box = el.getBoundingClientRect();
    // El carril de la barra de scroll está dentro del contenedor, a la derecha de la grilla.
    const scrollbar = term.options.scrollbar?.width ?? 14;
    let { cols, rows } = term;
    // El medio píxel de tolerancia evita que el ruido de subpíxel dispare una corrección
    // donde entra justo.
    if (canvas.height > box.height + 0.5 && rows > 1) rows -= 1;
    if (canvas.width + scrollbar > box.width + 0.5 && cols > 2) cols -= 1;
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  };

  const fit = () => {
    try {
      addon.fit();
      trimOverflow();
    } catch {
      // ignorar si el terminal fue dispose()d
    }
  };

  /**
   * Primer ajuste, antes de spawnear el proceso (el PTY nace con este tamaño, no con uno
   * fijo que se corrige después).
   *
   * - `document.fonts.ready`: si se mide con la fuente de fallback, se calculan cols/rows
   *   para celdas de un tamaño que no es el real. (La fuente de la terminal además se
   *   precarga al arrancar la app, ver `main.tsx`.)
   * - Doble rAF: el primero solo garantiza que el layout se pintó una vez; medir antes de
   *   eso puede dar un contenedor todavía en 0×0 (tab recién creada).
   */
  const fitOnce = async () => {
    await document.fonts.ready.catch(() => {});
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    fit();
  };

  return { fit, fitOnce };
}
