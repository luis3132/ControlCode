/**
 * Dónde cae una tab que se suelta. Geometría pura, probada en `tests/dropTarget.test.ts`;
 * el arrastre (`tabDrag.ts`) la usa con lo que mide del DOM.
 */
import type { SplitSide } from "./layoutTree";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Qué fracción de cada borde divide. Más adentro, la tab se muda al grupo. */
export const EDGE = 0.28;

/**
 * La zona de un grupo bajo el puntero (`rx`, `ry` en 0..1 dentro de su contenido): cerca de
 * un borde, dividir hacia ese lado; en el medio, mudarse. Con dos bordes cerca (una esquina)
 * gana el más cercano.
 */
export function zoneAt(rx: number, ry: number, edge = EDGE): SplitSide | "center" {
  const distances: [SplitSide, number][] = [["left", rx], ["right", 1 - rx], ["up", ry], ["down", 1 - ry]];
  const [side, distance] = distances.reduce((best, d) => (d[1] < best[1] ? d : best));
  return distance < edge ? side : "center";
}

/** La parte del grupo que ocuparía la tab: la mitad hacia ese lado, o todo. */
export function zoneBox(box: Box, side: SplitSide | "center"): Box {
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  switch (side) {
    case "left": return { ...box, width: halfW };
    case "right": return { ...box, left: box.left + halfW, width: halfW };
    case "up": return { ...box, height: halfH };
    case "down": return { ...box, top: box.top + halfH, height: halfH };
    case "center": return box;
  }
}

/**
 * En qué lugar de una tira entra la tab: antes de la primera cuya mitad queda a la derecha
 * del puntero. `x` de la marca: el borde izquierdo de esa tab, o el derecho de la última.
 */
export function stripSlot(x: number, tabs: { left: number; width: number }[]): { index: number; lineX: number } {
  const index = tabs.findIndex((t) => x < t.left + t.width / 2);
  if (index === -1) {
    const last = tabs[tabs.length - 1];
    return { index: tabs.length, lineX: last ? last.left + last.width : x };
  }
  return { index, lineX: tabs[index]!.left };
}

/**
 * Si soltar ahí no cambia nada: el centro del propio grupo, o un borde del propio grupo
 * cuando es su única tab (dividirlo dejaría el mismo grupo al lado de uno vacío).
 */
export function isNoop(side: SplitSide | "center", sameGroup: boolean, groupSize: number): boolean {
  if (!sameGroup) return false;
  return side === "center" || groupSize <= 1;
}
