/**
 * Lo que se dibuja sobre la página congelada y cómo se pinta. El modelo es puro (probado en
 * `tests/annotate.test.ts`); `drawShape` pinta sobre cualquier cosa con la forma de un
 * contexto 2D.
 */
import { arrowWings, isLight, rectBetween, smoothSegments, type Point } from "./geometry";

export type Tool = "pen" | "marker" | "arrow" | "rect" | "text";

export const COLORS = [
  { id: "red", value: "#ef4444" },
  { id: "yellow", value: "#facc15" },
  { id: "green", value: "#22c55e" },
  { id: "blue", value: "#3b82f6" },
  { id: "black", value: "#111827" },
  { id: "white", value: "#ffffff" },
] as const;

export type StrokeSize = "thin" | "medium" | "thick";

/** Grosor en px CSS: se multiplica por la escala de la captura para verse igual que en pantalla. */
export const STROKE_WIDTH: Record<StrokeSize, number> = { thin: 2, medium: 4, thick: 8 };
export const TEXT_SIZE: Record<StrokeSize, number> = { thin: 14, medium: 18, thick: 26 };

/** El resaltador es ancho y transparente, para marcar sin tapar lo que hay abajo. */
const MARKER_FACTOR = 4;
const MARKER_ALPHA = 0.35;

export type Shape =
  | { kind: "pen" | "marker"; color: string; width: number; points: Point[] }
  | { kind: "arrow" | "rect"; color: string; width: number; from: Point; to: Point }
  | { kind: "text"; color: string; size: number; at: Point; text: string };

/** Un trazo tan corto que fue un click, no un dibujo. El lápiz sí lo guarda: es un punto. */
export function isEmptyShape(shape: Shape): boolean {
  if (shape.kind === "text") return shape.text.trim() === "";
  if ("points" in shape) return shape.points.length === 0;
  return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < 3;
}

// ── Historial ───────────────────────────────────────────────────────

/** Cada estado del dibujo entero: deshacer "borrar todo" vuelve a mostrar todo. */
export interface History {
  past: Shape[][];
  present: Shape[];
  future: Shape[][];
}

export const EMPTY_HISTORY: History = { past: [], present: [], future: [] };

function commit(history: History, present: Shape[]): History {
  return { past: [...history.past, history.present], present, future: [] };
}

export const addShape = (history: History, shape: Shape): History =>
  isEmptyShape(shape) ? history : commit(history, [...history.present, shape]);

export const clearShapes = (history: History): History =>
  history.present.length === 0 ? history : commit(history, []);

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...future] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future };
}

// ── Pintar ──────────────────────────────────────────────────────────

/** Lo que usa `drawShape` de un `CanvasRenderingContext2D`. */
export type Ctx = Pick<CanvasRenderingContext2D,
  | "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "stroke" | "fill" | "closePath"
  | "strokeRect" | "arc" | "fillText" | "strokeText"
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textBaseline: CanvasTextBaseline;
};

export const FONT_FAMILY = `system-ui, -apple-system, "Segoe UI", sans-serif`;

export function textFont(size: number): string {
  return `600 ${size}px ${FONT_FAMILY}`;
}

export function drawShape(ctx: Ctx, shape: Shape): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (shape.kind) {
    case "pen":
    case "marker": {
      const marker = shape.kind === "marker";
      const width = marker ? shape.width * MARKER_FACTOR : shape.width;
      if (marker) ctx.globalAlpha = MARKER_ALPHA;
      const path = smoothSegments(shape.points);
      if (!path) break;
      if (path.segments.length === 0) {
        // Un click suelto: un punto del grosor del trazo.
        ctx.beginPath();
        ctx.arc(path.start.x, path.start.y, width / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(path.start.x, path.start.y);
      for (const s of path.segments) ctx.quadraticCurveTo(s.control.x, s.control.y, s.end.x, s.end.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      const [a, b] = arrowWings(shape.from, shape.to, shape.width);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case "rect": {
      ctx.lineWidth = shape.width;
      const r = rectBetween(shape.from, shape.to);
      ctx.strokeRect(r.left, r.top, r.width, r.height);
      break;
    }
    case "text": {
      ctx.font = textFont(shape.size);
      ctx.textBaseline = "top";
      // Un borde del color opuesto: el texto se lee igual sobre una zona clara o una oscura.
      ctx.strokeStyle = isLight(shape.color) ? "#111827" : "#ffffff";
      ctx.lineWidth = Math.max(2, shape.size / 5);
      const lineHeight = shape.size * 1.25;
      shape.text.split("\n").forEach((line, i) => {
        ctx.strokeText(line, shape.at.x, shape.at.y + i * lineHeight);
        ctx.fillText(line, shape.at.x, shape.at.y + i * lineHeight);
      });
      break;
    }
  }
  ctx.restore();
}
