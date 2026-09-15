/**
 * El tamaño de pantalla con el que se prueba la página.
 *
 * Solo ancho y alto, y a propósito: es lo que deciden las media queries, que es lo que
 * rompe un layout. Lo que un iframe NO puede fingir —el user agent, la densidad de
 * píxeles, el táctil— no se promete, porque un "iPhone" que no se comporta como uno
 * haría creer que algo anda en el teléfono cuando solo anda a 390 px.
 */

export interface Viewport {
  width: number;
  height: number;
}

export type DeviceKind = "phone" | "tablet" | "laptop" | "desktop";

export interface ViewportPreset extends Viewport {
  id: string;
  kind: DeviceKind;
}

/** Los tamaños más comunes de cada clase. Los ids se usan también desde el MCP. */
export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: "phone-small", kind: "phone", width: 360, height: 640 },
  { id: "phone", kind: "phone", width: 390, height: 844 },
  { id: "phone-large", kind: "phone", width: 430, height: 932 },
  { id: "tablet", kind: "tablet", width: 768, height: 1024 },
  { id: "tablet-large", kind: "tablet", width: 1024, height: 1366 },
  { id: "laptop", kind: "laptop", width: 1280, height: 800 },
  { id: "desktop", kind: "desktop", width: 1440, height: 900 },
  { id: "desktop-large", kind: "desktop", width: 1920, height: 1080 },
];

export const MIN_SIDE = 240;
export const MAX_SIDE = 3840;

const clampSide = (n: number) => Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, n)));

export function clampViewport(v: Viewport): Viewport {
  return { width: clampSide(v.width), height: clampSide(v.height) };
}

export function presetById(id: string): ViewportPreset | undefined {
  return VIEWPORT_PRESETS.find((p) => p.id === id);
}

/** El preset que coincide con este tamaño, en cualquier orientación. */
export function presetOf(v: Viewport): { preset: ViewportPreset; rotated: boolean } | undefined {
  for (const preset of VIEWPORT_PRESETS) {
    if (preset.width === v.width && preset.height === v.height) return { preset, rotated: false };
    if (preset.width === v.height && preset.height === v.width) return { preset, rotated: true };
  }
  return undefined;
}

export function rotate(v: Viewport): Viewport {
  return { width: v.height, height: v.width };
}

/**
 * Cuánto hay que achicar el marco para que entre en el espacio disponible. Nunca agranda:
 * a más de 1 los píxeles de la página dejarían de ser los que ve el usuario de verdad.
 */
export function fitScale(v: Viewport, available: Viewport): number {
  if (available.width <= 0 || available.height <= 0) return 1;
  const scale = Math.min(1, available.width / v.width, available.height / v.height);
  return Math.max(0.1, Math.floor(scale * 100) / 100);
}

/** Los cortes de las librerías que más se usan, para leer el ancho en sus términos. */
const BREAKPOINTS: [string, number][] = [["2xl", 1536], ["xl", 1280], ["lg", 1024], ["md", 768], ["sm", 640]];

/** `md` para 800 px: el breakpoint de Tailwind en el que cae el ancho. */
export function breakpointOf(width: number): string {
  return BREAKPOINTS.find(([, min]) => width >= min)?.[0] ?? "xs";
}
