/**
 * Cuándo caben los dos paneles laterales a la vez.
 *
 * Abiertos los dos se llevan 608px (riel y Carpetas a la izquierda, el explorador a la
 * derecha). En una ventana chica eso deja a las terminales con una tira en el medio, así que
 * por debajo de cierto ancho solo queda desplegado uno: abrir uno pliega el otro, y achicar
 * la ventana pliega el que se abrió antes. Lo que la app plegó por falta de lugar (no la
 * persona) vuelve a abrirse solo cuando la ventana se agranda.
 *
 * Funciones puras sobre el estado de los paneles: el store las aplica, y se prueban sin él.
 */

export type Side = "workspaces" | "explorer";

/** 320 (riel + Carpetas) + 288 (explorador) + unos 670 para las terminales. */
export const BOTH_PANELS_MIN_WIDTH = 1280;

export interface PanelState {
  workspacesCollapsed: boolean;
  explorerCollapsed: boolean;
  /** El último que se desplegó: es el que se queda si hay que plegar uno. */
  lastOpened: Side;
  /** El que plegó la app por falta de lugar, para reabrirlo cuando vuelva a haber. */
  autoCollapsed: Side | null;
}

const KEY: Record<Side, "workspacesCollapsed" | "explorerCollapsed"> = {
  workspaces: "workspacesCollapsed",
  explorer: "explorerCollapsed",
};
const other = (side: Side): Side => (side === "workspaces" ? "explorer" : "workspaces");

/** Desplegar uno. Si no caben los dos, el otro se pliega (y se recuerda que fue la app). */
export function openPanel(s: PanelState, side: Side, width: number): Partial<PanelState> {
  const patch: Partial<PanelState> = { [KEY[side]]: false, lastOpened: side };
  if (s.autoCollapsed === side) patch.autoCollapsed = null;
  const rest = other(side);
  if (width < BOTH_PANELS_MIN_WIDTH && !s[KEY[rest]]) {
    patch[KEY[rest]] = true;
    patch.autoCollapsed = rest;
  }
  return patch;
}

/** Plegar uno a mano: si era el que la app iba a reabrir, ya no. */
export function closePanel(s: PanelState, side: Side): Partial<PanelState> {
  return { [KEY[side]]: true, ...(s.autoCollapsed === side ? { autoCollapsed: null } : {}) };
}

/** Lo que cambia con un ancho nuevo de la ventana. Vacío si no hay nada que tocar. */
export function fitPanels(s: PanelState, width: number): Partial<PanelState> {
  const bothOpen = !s.workspacesCollapsed && !s.explorerCollapsed;
  if (width < BOTH_PANELS_MIN_WIDTH) {
    if (!bothOpen) return {};
    const drop = other(s.lastOpened);
    return { [KEY[drop]]: true, autoCollapsed: drop };
  }
  if (s.autoCollapsed && s[KEY[s.autoCollapsed]]) {
    return { [KEY[s.autoCollapsed]]: false, autoCollapsed: null };
  }
  return {};
}
