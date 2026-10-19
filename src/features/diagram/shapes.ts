/**
 * Cómo se dibuja cada cosa de un diagrama: las formas, los colores, el texto y las flechas.
 *
 * Lo usan las DOS salidas —el editor y la exportación a SVG/PNG/PDF—, así lo que se exporta
 * es exactamente lo que se ve. Por eso el texto se parte en líneas acá y no lo parte el
 * navegador: un SVG no sabe hacerlo.
 *
 * El diagrama es "papel": colores claros que se leen igual en la app oscura, en un PDF o
 * pegados en un documento.
 *
 * Puro: se prueba en Node.
 */
import type { Arrow, ColorName, DiagramEdge, DiagramNode, Route, Shape } from "./model";

export interface Swatch {
  fill: string;
  stroke: string;
  text: string;
}

export const PALETTE: Record<ColorName, Swatch> = {
  default: { fill: "#ffffff", stroke: "#334155", text: "#0f172a" },
  gray: { fill: "#f1f5f9", stroke: "#64748b", text: "#0f172a" },
  blue: { fill: "#dbeafe", stroke: "#2563eb", text: "#1e3a8a" },
  green: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
  amber: { fill: "#fef3c7", stroke: "#d97706", text: "#78350f" },
  red: { fill: "#fee2e2", stroke: "#dc2626", text: "#7f1d1d" },
  violet: { fill: "#ede9fe", stroke: "#7c3aed", text: "#4c1d95" },
  cyan: { fill: "#cffafe", stroke: "#0891b2", text: "#164e63" },
};

export const PAPER = "#fafaf9";
export const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
export const FONT_SIZE = 14;
export const LINE_HEIGHT = 18;

export const swatch = (color?: ColorName) => PALETTE[color ?? "default"];

/** Los colores de un grupo: el relleno muy tenue, para que lo de adentro se lea. */
export function groupSwatch(color?: ColorName): Swatch {
  const s = swatch(color);
  return { fill: color && color !== "default" ? `${s.fill}99` : "#f1f5f966", stroke: color ? s.stroke : "#94a3b8", text: s.text };
}

const r = (n: number) => Math.round(n * 10) / 10;

/** El contorno de una forma de `w`×`h`, en coordenadas locales. `extra` es lo que se dibuja
 *  encima sin relleno (la boca de un cilindro, el cuerpo de un actor). */
export function shapeOutline(shape: Shape, w: number, h: number): { d: string; extra?: string } {
  switch (shape) {
    case "rect":
    case "text":
      return { d: `M0,0H${r(w)}V${r(h)}H0Z` };
    case "rounded":
    case "group": {
      const k = r(Math.min(shape === "group" ? 10 : 12, h / 4, w / 4));
      return { d: `M${k},0H${r(w - k)}A${k},${k} 0 0 1 ${r(w)},${k}V${r(h - k)}A${k},${k} 0 0 1 ${r(w - k)},${r(h)}H${k}A${k},${k} 0 0 1 0,${r(h - k)}V${k}A${k},${k} 0 0 1 ${k},0Z` };
    }
    case "diamond":
      return { d: `M${r(w / 2)},0L${r(w)},${r(h / 2)}L${r(w / 2)},${r(h)}L0,${r(h / 2)}Z` };
    case "ellipse":
      return { d: `M0,${r(h / 2)}A${r(w / 2)},${r(h / 2)} 0 1 1 ${r(w)},${r(h / 2)}A${r(w / 2)},${r(h / 2)} 0 1 1 0,${r(h / 2)}Z` };
    case "parallelogram": {
      const o = r(Math.min(w * 0.15, 24));
      return { d: `M${o},0H${r(w)}L${r(w - o)},${r(h)}H0Z` };
    }
    case "cylinder": {
      const ry = r(Math.min(h * 0.15, 14));
      const rx = r(w / 2);
      return {
        d: `M0,${ry}A${rx},${ry} 0 0 1 ${r(w)},${ry}V${r(h - ry)}A${rx},${ry} 0 0 1 0,${r(h - ry)}Z`,
        extra: `M0,${ry}A${rx},${ry} 0 0 0 ${r(w)},${ry}`,
      };
    }
    case "document": {
      const wave = r(Math.min(h * 0.12, 12));
      return { d: `M0,0H${r(w)}V${r(h - wave)}C${r(w * 0.75)},${r(h - 3 * wave)} ${r(w * 0.25)},${r(h + wave)} 0,${r(h - wave)}Z` };
    }
    case "cloud": {
      // Una nube de cinco lóbulos sobre una grilla de 0..1, escalada.
      const p = (x: number, y: number) => `${r(x * w)},${r(y * h)}`;
      return {
        d: `M${p(0.25, 0.85)}C${p(0.05, 0.85)} ${p(0.02, 0.55)} ${p(0.18, 0.5)}C${p(0.12, 0.25)} ${p(0.38, 0.12)} ${p(0.5, 0.25)}`
          + `C${p(0.58, 0.05)} ${p(0.85, 0.08)} ${p(0.82, 0.35)}C${p(1, 0.38)} ${p(1, 0.75)} ${p(0.8, 0.85)}Z`,
      };
    }
    case "actor": {
      // La figura arriba; el nombre va debajo (ver `labelBox`).
      const fh = Math.max(20, h - LINE_HEIGHT - 6);
      const cx = r(w / 2);
      const head = r(Math.min(w * 0.18, fh * 0.16));
      const neck = head * 2 + 1;
      const hip = fh * 0.62;
      return {
        d: `M${cx},${r(head)}m-${head},0a${head},${head} 0 1 0 ${r(head * 2)},0a${head},${head} 0 1 0 -${r(head * 2)},0`,
        extra: `M${cx},${r(neck)}V${r(hip)}M${r(w * 0.15)},${r(fh * 0.38)}H${r(w * 0.85)}M${cx},${r(hip)}L${r(w * 0.2)},${r(fh)}M${cx},${r(hip)}L${r(w * 0.8)},${r(fh)}`,
      };
    }
  }
}

/** Dónde va el texto de un nodo, en coordenadas locales: el centro, salvo un grupo (arriba a
 *  la izquierda) y un actor (debajo de la figura). */
export function labelBox(node: Pick<DiagramNode, "shape" | "w" | "h">): { x: number; y: number; w: number; h: number; anchor: "middle" | "start" } {
  const { shape, w, h } = node;
  if (shape === "group") return { x: 10, y: 6, w: w - 20, h: LINE_HEIGHT + 4, anchor: "start" };
  if (shape === "actor") return { x: -30, y: h - LINE_HEIGHT - 2, w: w + 60, h: LINE_HEIGHT + 2, anchor: "middle" };
  // Lo que se puede usar adentro de la forma sin tocar el borde.
  const inset = shape === "diamond" ? 0.22 : shape === "ellipse" || shape === "cloud" ? 0.14 : shape === "parallelogram" ? 0.12 : 0.05;
  return { x: w * inset, y: 4, w: w * (1 - 2 * inset), h: h - 8, anchor: "middle" };
}

/** Ancho aproximado de un texto: sin medir (esto también corre fuera del navegador). */
export function textWidth(text: string, size = FONT_SIZE): number {
  let units = 0;
  for (const ch of text) units += /[MW@#%&]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.64 : /[iljtf.,:;'|!]/.test(ch) ? 0.3 : ch === " " ? 0.3 : 0.53;
  return units * size;
}

/** El texto partido en las líneas que entran en `width`; los saltos de línea se respetan. */
export function wrapText(text: string, width: number, size = FONT_SIZE): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** Las líneas del texto de un nodo y dónde va la primera (su línea base), centradas en
 *  vertical en su caja. Lo que no entra se corta con "…". */
export function labelLines(node: Pick<DiagramNode, "shape" | "label" | "w" | "h">): { lines: string[]; x: number; y: number; anchor: "middle" | "start" } {
  const box = labelBox(node);
  const all = wrapText(node.label, Math.max(20, box.w));
  const fit = Math.max(1, Math.floor(box.h / LINE_HEIGHT));
  const lines = all.length > fit ? [...all.slice(0, fit - 1), `${all[fit - 1]}…`] : all;
  const x = box.anchor === "middle" ? box.x + box.w / 2 : box.x;
  const top = node.shape === "group" || node.shape === "actor" ? box.y : box.y + (box.h - lines.length * LINE_HEIGHT) / 2;
  return { lines, x, y: top + LINE_HEIGHT * 0.75, anchor: box.anchor };
}

// ── Flechas ─────────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number };
export type Side = "left" | "right" | "top" | "bottom";

export interface EdgeGeometry {
  path: string;
  /** Dónde va la etiqueta. */
  label: { x: number; y: number };
  source: { x: number; y: number; side: Side };
  target: { x: number; y: number; side: Side };
}

function anchor(box: Box, side: Side) {
  switch (side) {
    case "left": return { x: box.x, y: box.y + box.h / 2, side };
    case "right": return { x: box.x + box.w, y: box.y + box.h / 2, side };
    case "top": return { x: box.x + box.w / 2, y: box.y, side };
    case "bottom": return { x: box.x + box.w / 2, y: box.y + box.h, side };
  }
}

/** Por qué lados sale y entra una flecha: los que se miran, según dónde está uno del otro. */
export function edgeSides(a: Box, b: Box): [Side, Side] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  // Separados de costado (no se solapan en horizontal): de lado a lado.
  const apartX = b.x >= a.x + a.w || a.x >= b.x + b.w;
  const apartY = b.y >= a.y + a.h || a.y >= b.y + b.h;
  const horizontal = apartX && (!apartY || Math.abs(dx) >= Math.abs(dy));
  if (horizontal) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

const isHorizontal = (side: Side) => side === "left" || side === "right";

/** De qué lado de la caja está un punto de su borde. */
function sideOf(box: Box, p: { x: number; y: number }): Side {
  const d = [
    ["left", Math.abs(p.x - box.x)], ["right", Math.abs(p.x - (box.x + box.w))],
    ["top", Math.abs(p.y - box.y)], ["bottom", Math.abs(p.y - (box.y + box.h))],
  ] as const;
  return [...d].sort((m, n) => m[1] - n[1])[0]![0];
}

/** El recorrido que calculó ELK, como camino: por sus quiebres, con la etiqueta donde ELK le
 *  dejó lugar (o en medio del tramo del medio). */
function routedGeometry(a: Box, b: Box, points: { x: number; y: number }[], labelAt?: { x: number; y: number }): EdgeGeometry {
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)},${r(p.y)}`).join("");
  const mid = Math.floor((points.length - 1) / 2);
  const p = points[mid]!;
  const q = points[mid + 1] ?? p;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    path,
    label: labelAt ?? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
    source: { ...first, side: sideOf(a, first) },
    target: { ...last, side: sideOf(b, last) },
  };
}

/**
 * El camino de una flecha entre dos cajas. Si el acomodado automático le calculó un recorrido
 * (`routed`), ese; si no, recto, en escalera (como draw.io) o curvo.
 */
export function edgeGeometry(
  a: Box, b: Box, route: Route = "orthogonal",
  routed?: { points?: { x: number; y: number }[]; labelAt?: { x: number; y: number } },
): EdgeGeometry {
  if (routed?.points && routed.points.length >= 2) return routedGeometry(a, b, routed.points, routed.labelAt);
  // A sí mismo: un rulo sobre el lado derecho.
  if (a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)) {
    const x = a.x + a.w;
    const y1 = a.y + a.h * 0.3;
    const y2 = a.y + a.h * 0.7;
    return {
      path: `M${r(x)},${r(y1)}C${r(x + 50)},${r(y1 - 10)} ${r(x + 50)},${r(y2 + 10)} ${r(x)},${r(y2)}`,
      label: { x: x + 44, y: (y1 + y2) / 2 },
      source: { x, y: y1, side: "right" },
      target: { x, y: y2, side: "right" },
    };
  }
  const [from, to] = edgeSides(a, b);
  const s = anchor(a, from);
  const t = anchor(b, to);
  const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
  if (route === "straight") {
    return { path: `M${r(s.x)},${r(s.y)}L${r(t.x)},${r(t.y)}`, label: mid, source: s, target: t };
  }
  if (route === "curved") {
    const pull = Math.max(40, Math.hypot(t.x - s.x, t.y - s.y) / 3);
    const c1 = isHorizontal(from) ? { x: s.x + (from === "right" ? pull : -pull), y: s.y } : { x: s.x, y: s.y + (from === "bottom" ? pull : -pull) };
    const c2 = isHorizontal(to) ? { x: t.x + (to === "right" ? pull : -pull), y: t.y } : { x: t.x, y: t.y + (to === "bottom" ? pull : -pull) };
    return {
      path: `M${r(s.x)},${r(s.y)}C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(t.x)},${r(t.y)}`,
      label: { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 },
      source: s,
      target: t,
    };
  }
  // En escalera: sale derecho de su lado, dobla a mitad de camino y entra derecho.
  if (isHorizontal(from)) {
    if (Math.abs(s.y - t.y) < 1) return { path: `M${r(s.x)},${r(s.y)}H${r(t.x)}`, label: mid, source: s, target: t };
    return { path: `M${r(s.x)},${r(s.y)}H${r(mid.x)}V${r(t.y)}H${r(t.x)}`, label: mid, source: s, target: t };
  }
  if (Math.abs(s.x - t.x) < 1) return { path: `M${r(s.x)},${r(s.y)}V${r(t.y)}`, label: mid, source: s, target: t };
  return { path: `M${r(s.x)},${r(s.y)}V${r(mid.y)}H${r(t.x)}V${r(t.y)}`, label: mid, source: s, target: t };
}

export const arrowAtEnd = (arrow?: Arrow) => (arrow ?? "end") === "end" || arrow === "both";
export const arrowAtStart = (arrow?: Arrow) => arrow === "start" || arrow === "both";

export function edgeColor(edge: Pick<DiagramEdge, "color">): string {
  return edge.color ? PALETTE[edge.color].stroke : "#475569";
}
