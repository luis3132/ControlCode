import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Ajustar la grilla de la terminal al tamaño real del contenedor.
 *
 * `fit()` divide el alto disponible por el alto de celda *teórico* y redondea hacia abajo.
 * Pero lo que el motor rasteriza no siempre mide eso: con escalado fraccionario (Wayland
 * al 125%/150%) cada fila se redondea a píxeles de dispositivo y el error se acumula, así
 * que las N filas calculadas terminan ocupando unos píxeles MÁS que el contenedor — y la
 * última queda cortada contra el borde inferior.
 *
 * En vez de intentar predecir ese redondeo, se mide lo que realmente quedó pintado y, si
 * desborda, se saca una fila.
 */
export function createFitter(term: XTerm, addon: FitAddon, container: () => HTMLElement | null) {
  /** El medio píxel de tolerancia evita que el ruido de subpíxel dispare una corrección
   *  donde entra justo. */
  const trimOverflowingRow = () => {
    const el = container();
    const screen = el?.querySelector<HTMLElement>(".xterm-screen");
    if (!el || !screen) return;
    const style = getComputedStyle(el);
    const available =
      el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (screen.getBoundingClientRect().height > available + 0.5 && term.rows > 1) {
      term.resize(term.cols, term.rows - 1);
    }
  };

  const fit = () => {
    try {
      addon.fit();
      trimOverflowingRow();
    } catch {
      // ignorar si el terminal fue dispose()d
    }
  };

  /**
   * Primer ajuste, antes de spawnear el proceso (el PTY nace con este tamaño, no con uno
   * fijo que se corrige después).
   *
   * - `document.fonts.ready`: si se mide con la fuente de fallback (porque "Cascadia
   *   Code"/"JetBrains Mono"/"Fira Code" todavía no cargó), se calculan cols/rows para
   *   celdas de un tamaño que no es el real — al terminar de cargar la fuente, el
   *   contenido desborda o queda recortado por el `overflow: hidden` del contenedor.
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
