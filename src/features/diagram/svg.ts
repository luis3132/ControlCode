/**
 * Un diagrama como SVG: lo que se exporta (y lo que se convierte en PNG y PDF). Usa las
 * mismas formas, colores y flechas que el editor (`shapes.ts`).
 *
 * Puro: se prueba en Node.
 */
import { bounds, parentsFirst, type Diagram, type DiagramEdge, type DiagramNode } from "./model";
import {
  FONT, FONT_SIZE, LINE_HEIGHT, PAPER, arrowAtEnd, arrowAtStart, edgeColor, edgeGeometry, groupSwatch, labelLines,
  shapeOutline, swatch,
} from "./shapes";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function nodeSvg(node: DiagramNode): string {
  const { d, extra } = shapeOutline(node.shape, node.w, node.h);
  const colors = node.shape === "group" ? groupSwatch(node.color) : swatch(node.color);
  const parts: string[] = [];
  if (node.shape !== "text") {
    const dash = node.shape === "group" ? ` stroke-dasharray="6 4"` : "";
    parts.push(`<path d="${d}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.5"${dash}/>`);
    if (extra) parts.push(`<path d="${extra}" fill="none" stroke="${colors.stroke}" stroke-width="1.5"/>`);
  }
  const label = labelLines(node);
  if (label.lines.some(Boolean)) {
    const weight = node.shape === "group" ? ` font-weight="600"` : "";
    const tspans = label.lines
      .map((line, i) => `<tspan x="${label.x}" y="${(label.y + i * LINE_HEIGHT).toFixed(1)}">${esc(line)}</tspan>`)
      .join("");
    parts.push(`<text fill="${colors.text}" text-anchor="${label.anchor}" font-size="${FONT_SIZE}"${weight}>${tspans}</text>`);
  }
  return `<g transform="translate(${node.x} ${node.y})">${parts.join("")}</g>`;
}

function markerId(color: string, start: boolean) {
  return `a${start ? "s" : "e"}${color.replace("#", "")}`;
}

export function edgeSvg(edge: DiagramEdge, nodes: Map<string, DiagramNode>): string {
  const a = nodes.get(edge.from);
  const b = nodes.get(edge.to);
  if (!a || !b) return "";
  const geo = edgeGeometry(a, b, edge.route, edge);
  const color = edgeColor(edge);
  const dash = edge.style === "dashed" ? ` stroke-dasharray="6 5"` : "";
  const end = arrowAtEnd(edge.arrow) ? ` marker-end="url(#${markerId(color, false)})"` : "";
  const start = arrowAtStart(edge.arrow) ? ` marker-start="url(#${markerId(color, true)})"` : "";
  const parts = [`<path d="${geo.path}" fill="none" stroke="${color}" stroke-width="1.5"${dash}${end}${start}/>`];
  if (edge.label) {
    const w = Math.max(...edge.label.split("\n").map((l) => l.length)) * FONT_SIZE * 0.5 + 12;
    const lines = edge.label.split("\n");
    const h = lines.length * LINE_HEIGHT + 4;
    parts.push(`<rect x="${(geo.label.x - w / 2).toFixed(1)}" y="${(geo.label.y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="4" fill="${PAPER}"/>`);
    const tspans = lines
      .map((line, i) => `<tspan x="${geo.label.x.toFixed(1)}" y="${(geo.label.y - h / 2 + 2 + LINE_HEIGHT * (i + 0.75)).toFixed(1)}">${esc(line)}</tspan>`)
      .join("");
    parts.push(`<text fill="#334155" text-anchor="middle" font-size="${FONT_SIZE - 1}">${tspans}</text>`);
  }
  return parts.join("");
}

/** Las puntas de flecha que usa el diagrama, una por color y sentido. */
export function markerDefs(edges: DiagramEdge[]): string {
  const seen = new Set<string>();
  const defs: string[] = [];
  for (const edge of edges) {
    const color = edgeColor(edge);
    for (const start of [false, true]) {
      if (start ? !arrowAtStart(edge.arrow) : !arrowAtEnd(edge.arrow)) continue;
      const id = markerId(color, start);
      if (seen.has(id)) continue;
      seen.add(id);
      defs.push(`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="${start ? "auto-start-reverse" : "auto"}"><path d="M0,0L10,5L0,10Z" fill="${color}"/></marker>`);
    }
  }
  return defs.join("");
}

/** El diagrama entero como documento SVG, con su fondo de papel y un margen. */
export function toSvg(diagram: Diagram, opts: { margin?: number; background?: string | null } = {}): string {
  const box = bounds(diagram, opts.margin ?? 32);
  const nodes = new Map(diagram.nodes.map((n) => [n.id, n]));
  const ordered = parentsFirst(diagram.nodes);
  const groups = ordered.filter((n) => n.shape === "group");
  const rest = ordered.filter((n) => n.shape !== "group");
  const background = opts.background === undefined ? PAPER : opts.background;
  const w = Math.ceil(box.w);
  const h = Math.ceil(box.h);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${box.x} ${box.y} ${w} ${h}" font-family="${esc(FONT)}">`,
    diagram.title ? `<title>${esc(diagram.title)}</title>` : "",
    `<defs>${markerDefs(diagram.edges)}</defs>`,
    background ? `<rect x="${box.x}" y="${box.y}" width="${w}" height="${h}" fill="${background}"/>` : "",
    // Los grupos atrás, después las flechas, y las formas encima de las flechas.
    ...groups.map(nodeSvg),
    ...diagram.edges.map((e) => edgeSvg(e, nodes)),
    ...rest.map(nodeSvg),
    "</svg>",
  ].join("");
}
