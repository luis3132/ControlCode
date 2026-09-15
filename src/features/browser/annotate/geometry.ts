/**
 * Las cuentas del lienzo de anotaciones: qué parte de la foto de la app es la página, dónde
 * se muestra, y la forma de lo que se dibuja. Pura, probada en `tests/annotate.test.ts`.
 *
 * Todo lo dibujado se guarda en PÍXELES DE LA CAPTURA, no de pantalla: así la imagen que
 * recibe el agente tiene la resolución real, y el lienzo puede mostrarse más chico (si la
 * tab se achica mientras se anota) sin que los trazos se corran.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Qué rectángulo de la captura recortar, y qué rectángulo de la pantalla era. */
export interface Crop {
  /** En píxeles de la captura. */
  source: Box;
  /** En px CSS de la ventana: donde estaba la página cuando se capturó. */
  screen: Box;
}

function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/**
 * La parte visible de la página dentro de la foto del webview entero.
 *
 * `page` es el iframe; `clip`, lo que lo contiene y lo recorta (con un tamaño de dispositivo
 * el iframe puede ser más grande que su columna). La foto viene a la resolución del motor,
 * que no es la de CSS: la escala sale de comparar su ancho con el de la ventana.
 */
export function cropFor(page: Box, clip: Box, viewport: Size, image: Size): Crop | null {
  const visible = intersect(intersect(page, clip) ?? page, { left: 0, top: 0, ...viewport });
  if (!visible || viewport.width <= 0 || viewport.height <= 0) return null;
  const sx = image.width / viewport.width;
  const sy = image.height / viewport.height;
  const left = Math.max(0, Math.round(visible.left * sx));
  const top = Math.max(0, Math.round(visible.top * sy));
  const right = Math.min(image.width, Math.round((visible.left + visible.width) * sx));
  const bottom = Math.min(image.height, Math.round((visible.top + visible.height) * sy));
  if (right <= left || bottom <= top) return null;
  return { source: { left, top, width: right - left, height: bottom - top }, screen: visible };
}

/**
 * Dónde se muestra la página congelada dentro de su columna.
 *
 * Si la columna sigue igual, exactamente donde estaba: es lo que hace que se vea "congelada"
 * y no reemplazada. Si ya no entra (la tab se achicó), achicada y centrada.
 */
export function placePaper(screen: Size, offset: Point, column: Size): Box {
  const fits = offset.x >= 0 && offset.y >= 0
    && offset.x + screen.width <= column.width + 0.5 && offset.y + screen.height <= column.height + 0.5;
  if (fits) return { left: offset.x, top: offset.y, ...screen };
  const scale = Math.min(1, column.width / screen.width, column.height / screen.height);
  const width = screen.width * scale;
  const height = screen.height * scale;
  return { left: (column.width - width) / 2, top: (column.height - height) / 2, width, height };
}

/** Un punto de la pantalla en píxeles de la captura. */
export function toImagePoint(client: Point, paper: Box, image: Size): Point {
  return {
    x: ((client.x - paper.left) / paper.width) * image.width,
    y: ((client.y - paper.top) / paper.height) * image.height,
  };
}

/** El rectángulo entre dos esquinas, en cualquier dirección que se haya arrastrado. */
export function rectBetween(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Las dos alas de la punta de una flecha que va de `from` a `to`. */
export function arrowWings(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  // La punta crece con el grosor, pero nunca más que la mitad de la flecha.
  const head = Math.min(Math.max(10, width * 4.5), length / 2);
  const spread = Math.PI / 7;
  return [
    { x: to.x - head * Math.cos(angle - spread), y: to.y - head * Math.sin(angle - spread) },
    { x: to.x - head * Math.cos(angle + spread), y: to.y - head * Math.sin(angle + spread) },
  ];
}

/**
 * Un trazo a mano como curvas suaves: cada punto medio entre dos lecturas es donde se unen
 * las curvas, y la lectura hace de control. Dibujado punto a punto el lápiz sale en
 * serrucho, sobre todo con el mouse, que reporta pocos puntos.
 */
export function smoothSegments(points: Point[]): { start: Point; segments: { control: Point; end: Point }[] } | null {
  if (points.length === 0) return null;
  const start = points[0]!;
  if (points.length < 3) return { start, segments: points.slice(1).map((p) => ({ control: p, end: p })) };
  const segments: { control: Point; end: Point }[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const next = points[i + 1]!;
    segments.push({ control: p, end: { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 } });
  }
  const last = points[points.length - 1]!;
  segments.push({ control: last, end: last });
  return { start, segments };
}

/** Si un color es claro: el texto lleva un borde del color opuesto para leerse sobre cualquier fondo. */
export function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
}
