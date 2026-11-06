/**
 * Llevar lo que hace el mouse sobre la imagen de la pantalla a lo que hace un dedo sobre
 * el dispositivo. Puro: se prueba sin un teléfono.
 */
import type { UserInput } from "./ipc";

export interface Size {
  width: number;
  height: number;
}

/** El tamaño más grande con la proporción de `frame` que entra en `box`. */
export function fitInside(box: Size, frame: Size): Size {
  if (frame.width <= 0 || frame.height <= 0 || box.width <= 0 || box.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  return { width: Math.floor(frame.width * scale), height: Math.floor(frame.height * scale) };
}

/** Un punto sobre la imagen (relativo a su esquina) en píxeles del dispositivo, o `null`
 *  si cae afuera. */
export function toDevice(
  point: { x: number; y: number },
  shown: Size,
  frame: Size
): { x: number; y: number } | null {
  if (shown.width <= 0 || shown.height <= 0) return null;
  if (point.x < 0 || point.y < 0 || point.x > shown.width || point.y > shown.height) return null;
  return {
    x: Math.round((point.x / shown.width) * frame.width),
    y: Math.round((point.y / shown.height) * frame.height),
  };
}

/** Cuánto puede moverse el mouse (en píxeles de pantalla) y seguir siendo un toque. */
const TAP_SLOP = 8;
/** Desde cuánto apretado es un toque largo. */
const HOLD_MS = 500;

/** Qué gesto fue, según dónde empezó, dónde terminó y cuánto duró. */
export function gesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  screenDistance: number,
  ms: number
): UserInput {
  if (screenDistance < TAP_SLOP) {
    return ms >= HOLD_MS ? { kind: "hold", x: start.x, y: start.y, ms: Math.min(ms, 10_000) } : { kind: "tap", x: start.x, y: start.y };
  }
  return { kind: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y, ms: Math.max(60, Math.min(ms, 3000)) };
}

/**
 * La rueda del mouse como un dedo que arrastra: girar hacia abajo es querer ver lo de
 * abajo, así que el dedo sube. La distancia sigue a cuánto se giró, con un tope para no
 * pasar de largo media pantalla de un saque.
 */
export function wheelSwipe(at: { x: number; y: number }, deltaY: number, frame: Size): UserInput | null {
  if (deltaY === 0) return null;
  const distance = Math.min(Math.max(Math.abs(deltaY) * 2, frame.height * 0.08), frame.height * 0.45);
  const margin = frame.height * 0.06;
  const y = Math.min(Math.max(at.y, margin + distance * (deltaY > 0 ? 1 : 0)), frame.height - margin - distance * (deltaY > 0 ? 0 : 1));
  const y2 = deltaY > 0 ? y - distance : y + distance;
  return { kind: "swipe", x: at.x, y: Math.round(y), x2: at.x, y2: Math.round(y2), ms: 120 };
}
