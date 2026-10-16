/**
 * Un diagrama: formas unidas por flechas, para un diagrama de flujo o de arquitectura.
 *
 * Vive en un archivo del proyecto (`*.diagram.json`) y se versiona con el código. El
 * formato es nuestro y chico a propósito: un agente lo lee y lo escribe sin manual, y se
 * exporta a SVG, PNG, PDF y draw.io.
 *
 * Como en el canvas, todo cambio es una operación (`DiagramOp`) que pasa por
 * `applyDiagramOps`: el usuario y los agentes por el mismo camino, y cada operación dice
 * qué tocó para pintarlo del color de quien lo hizo.
 *
 * Las coordenadas son ABSOLUTAS también para lo que está adentro de un grupo: así un agente
 * no tiene que saber de grupos para ubicar algo. React Flow las quiere relativas a su padre
 * y se convierten al dibujar.
 *
 * Puro: se prueba en Node (`tests/model.test.ts`).
 */

export const SHAPES = [
  "rect", "rounded", "diamond", "ellipse", "parallelogram", "cylinder", "cloud", "actor", "document", "text", "group",
] as const;
export type Shape = (typeof SHAPES)[number];

export const COLORS = ["default", "gray", "blue", "green", "amber", "red", "violet", "cyan"] as const;
export type ColorName = (typeof COLORS)[number];

export type Arrow = "end" | "start" | "both" | "none";
export type LineStyle = "solid" | "dashed";
export type Route = "orthogonal" | "straight" | "curved";

export interface DiagramNode {
  id: string;
  shape: Shape;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: ColorName;
  /** El grupo que lo contiene. */
  parent?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  arrow?: Arrow;
  style?: LineStyle;
  route?: Route;
  color?: ColorName;
}

export interface Diagram {
  version: 1;
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type NodeInput = Partial<Omit<DiagramNode, "id">> & { id?: string };
export type EdgeInput = Partial<Omit<DiagramEdge, "id">> & { id?: string };

export type DiagramOp =
  | { op: "node.add"; node: NodeInput }
  | { op: "node.update"; id: string; patch: NodeInput }
  | { op: "node.remove"; id: string }
  | { op: "edge.add"; edge: EdgeInput }
  | { op: "edge.update"; id: string; patch: EdgeInput }
  | { op: "edge.remove"; id: string }
  | { op: "title"; title: string };

export interface DiagramResult {
  diagram: Diagram;
  /** Ids de lo creado o cambiado (nodos y flechas). */
  touched: string[];
  /** Por cada `node.add`/`edge.add`, el id con que quedó. */
  added: string[];
}

export const EMPTY_DIAGRAM: Diagram = { version: 1, nodes: [], edges: [] };

export const DEFAULT_NODE_SIZE: Record<Shape, { w: number; h: number }> = {
  rect: { w: 160, h: 70 },
  rounded: { w: 160, h: 70 },
  diamond: { w: 150, h: 100 },
  ellipse: { w: 150, h: 80 },
  parallelogram: { w: 170, h: 70 },
  cylinder: { w: 120, h: 100 },
  cloud: { w: 180, h: 110 },
  actor: { w: 70, h: 110 },
  document: { w: 150, h: 90 },
  text: { w: 160, h: 40 },
  group: { w: 420, h: 280 },
};

export const MIN_NODE = { w: 30, h: 24 };
const GAP = 60;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isShape = (v: unknown): v is Shape => SHAPES.includes(v as Shape);
const isColor = (v: unknown): v is ColorName => COLORS.includes(v as ColorName);
const ARROWS: Arrow[] = ["end", "start", "both", "none"];
const STYLES: LineStyle[] = ["solid", "dashed"];
const ROUTES: Route[] = ["orthogonal", "straight", "curved"];

/** Un id que se lee: `n1`, `n2`… o `e1`… el primero libre. */
function freeId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

const allIds = (d: Diagram) => new Set([...d.nodes.map((n) => n.id), ...d.edges.map((e) => e.id)]);

function requireNode(d: Diagram, id: string): DiagramNode {
  const node = d.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`El diagrama no tiene ningún nodo '${id}'. Nodos: ${d.nodes.map((n) => n.id).join(", ") || "ninguno"}`);
  return node;
}

function requireEdge(d: Diagram, id: string): DiagramEdge {
  const edge = d.edges.find((e) => e.id === id);
  if (!edge) throw new Error(`El diagrama no tiene ninguna flecha '${id}'`);
  return edge;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: DiagramNode): boolean {
  return a.x < b.x + b.w + GAP / 2 && a.x + a.w + GAP / 2 > b.x && a.y < b.y + b.h + GAP / 2 && a.y + a.h + GAP / 2 > b.y;
}

/** Un lugar libre para un nodo de ese tamaño: a la derecha de lo que ya hay, por filas. */
export function freeSpotIn(nodes: DiagramNode[], w: number, h: number): { x: number; y: number } {
  const others = nodes.filter((n) => n.shape !== "group");
  if (others.length === 0) return { x: 0, y: 0 };
  const free = (x: number, y: number) => !nodes.some((n) => n.shape !== "group" && overlaps({ x, y, w, h }, n));
  const ordered = [...others].sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
  for (const n of ordered) {
    const right = { x: n.x + n.w + GAP, y: n.y };
    if (free(right.x, right.y)) return right;
  }
  const bottom = Math.max(...others.map((n) => n.y + n.h));
  return { x: Math.min(...others.map((n) => n.x)), y: bottom + GAP };
}

/** Si `inner` cae adentro de `outer`. */
export function contains(outer: DiagramNode, inner: { x: number; y: number; w: number; h: number }): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Los ids de un grupo y todo lo que tiene adentro, a cualquier profundidad. */
export function descendants(d: Diagram, id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of d.nodes) {
      if (n.parent && out.has(n.parent) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Los padres antes que los hijos: React Flow lo exige, y el SVG dibuja así los grupos atrás. */
export function parentsFirst(nodes: DiagramNode[]): DiagramNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: DiagramNode): number => {
    let d = 0;
    let p = n.parent ? byId.get(n.parent) : undefined;
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      d++;
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return d;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

function cleanNode(input: NodeInput, base: DiagramNode, d: Diagram): DiagramNode {
  const node: DiagramNode = { ...base };
  if (input.shape !== undefined) {
    if (!isShape(input.shape)) throw new Error(`Forma desconocida '${input.shape}'. Formas: ${SHAPES.join(", ")}`);
    node.shape = input.shape;
  }
  if (typeof input.label === "string") node.label = input.label;
  if (finite(input.x)) node.x = Math.round(input.x);
  if (finite(input.y)) node.y = Math.round(input.y);
  if (finite(input.w)) node.w = Math.max(MIN_NODE.w, Math.round(input.w));
  if (finite(input.h)) node.h = Math.max(MIN_NODE.h, Math.round(input.h));
  if (input.color !== undefined) {
    if (input.color === "default" || (input.color as unknown) === null || (input.color as unknown) === "") delete node.color;
    else if (!isColor(input.color)) throw new Error(`Color desconocido '${input.color}'. Colores: ${COLORS.join(", ")}`);
    else node.color = input.color;
  }
  if (input.parent !== undefined) {
    if (!input.parent) delete node.parent;
    else {
      const parent = requireNode(d, input.parent);
      if (parent.shape !== "group") throw new Error(`'${input.parent}' no es un grupo: solo un grupo puede contener nodos`);
      if (descendants(d, node.id).has(parent.id)) throw new Error(`'${node.id}' no puede quedar adentro de sí mismo`);
      node.parent = parent.id;
    }
  }
  return node;
}

function cleanEdge(input: EdgeInput, base: DiagramEdge, d: Diagram): DiagramEdge {
  const edge: DiagramEdge = { ...base };
  if (input.from !== undefined) edge.from = requireNode(d, input.from).id;
  if (input.to !== undefined) edge.to = requireNode(d, input.to).id;
  if (input.label !== undefined) {
    if (input.label) edge.label = input.label;
    else delete edge.label;
  }
  const pick = <T extends string>(value: unknown, options: T[], name: string, key: "arrow" | "style" | "route") => {
    if (value === undefined) return;
    if (!options.includes(value as T)) throw new Error(`'${name}' tiene que ser ${options.join(", ")}`);
    (edge as unknown as Record<string, unknown>)[key] = value;
  };
  pick(input.arrow, ARROWS, "arrow", "arrow");
  pick(input.style, STYLES, "style", "style");
  pick(input.route, ROUTES, "route", "route");
  if (input.color !== undefined) {
    if (input.color === "default" || !input.color) delete edge.color;
    else if (!isColor(input.color)) throw new Error(`Color desconocido '${input.color}'`);
    else edge.color = input.color;
  }
  return edge;
}

/** El nodo dentro de otro grupo, o suelto si `parent` no está. */
function reparent(node: DiagramNode, parent: string | undefined): DiagramNode {
  const { parent: _old, ...rest } = node;
  return parent ? { ...rest, parent } : rest;
}

/**
 * Aplica las operaciones en orden; si una falla no se aplica ninguna. Las de un mismo lote
 * se ven entre sí: un agente puede crear `api` y `db` y unirlos en la misma llamada.
 */
export function applyDiagramOps(diagram: Diagram, ops: DiagramOp[]): DiagramResult {
  let d = diagram;
  const touched: string[] = [];
  const added: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "title":
        d = { ...d, title: op.title.trim() || undefined };
        if (!d.title) delete d.title;
        break;

      case "node.add": {
        const taken = allIds(d);
        const id = op.node.id?.trim() || freeId("n", taken);
        if (taken.has(id)) throw new Error(`Ya hay algo con id '${id}'`);
        const shape = op.node.shape ?? "rounded";
        if (!isShape(shape)) throw new Error(`Forma desconocida '${shape}'. Formas: ${SHAPES.join(", ")}`);
        const size = DEFAULT_NODE_SIZE[shape];
        const w = finite(op.node.w) ? op.node.w : size.w;
        const h = finite(op.node.h) ? op.node.h : size.h;
        const at = finite(op.node.x) && finite(op.node.y) ? { x: op.node.x, y: op.node.y } : freeSpotIn(d.nodes, w, h);
        const base: DiagramNode = { id, shape, label: "", x: at.x, y: at.y, w, h };
        const node = cleanNode({ ...op.node, shape, x: at.x, y: at.y, w, h }, base, d);
        d = { ...d, nodes: [...d.nodes, node] };
        added.push(id);
        touched.push(id);
        break;
      }

      case "node.update": {
        const node = requireNode(d, op.id);
        const updated = cleanNode(op.patch, node, d);
        // Mover un grupo mueve lo que tiene adentro.
        const dx = updated.x - node.x;
        const dy = updated.y - node.y;
        const inside = node.shape === "group" && (dx || dy) ? descendants(d, node.id) : null;
        d = {
          ...d,
          nodes: d.nodes.map((n) => {
            if (n.id === node.id) return updated;
            if (inside?.has(n.id)) return { ...n, x: n.x + dx, y: n.y + dy };
            return n;
          }),
        };
        touched.push(node.id);
        break;
      }

      case "node.remove": {
        const node = requireNode(d, op.id);
        // Lo de adentro de un grupo queda suelto, no se borra: borrar un recuadro no es
        // borrar los servicios que encerraba.
        d = {
          ...d,
          nodes: d.nodes.filter((n) => n.id !== node.id).map((n) => (n.parent === node.id ? reparent(n, node.parent) : n)),
          edges: d.edges.filter((e) => e.from !== node.id && e.to !== node.id),
        };
        break;
      }

      case "edge.add": {
        const taken = allIds(d);
        const id = op.edge.id?.trim() || freeId("e", taken);
        if (taken.has(id)) throw new Error(`Ya hay algo con id '${id}'`);
        if (!op.edge.from || !op.edge.to) throw new Error("Una flecha necesita 'from' y 'to'");
        const edge = cleanEdge(op.edge, { id, from: op.edge.from, to: op.edge.to }, d);
        d = { ...d, edges: [...d.edges, edge] };
        added.push(id);
        touched.push(id);
        break;
      }

      case "edge.update": {
        const edge = requireEdge(d, op.id);
        const updated = cleanEdge(op.patch, edge, d);
        d = { ...d, edges: d.edges.map((e) => (e.id === edge.id ? updated : e)) };
        touched.push(edge.id);
        break;
      }

      case "edge.remove":
        requireEdge(d, op.id);
        d = { ...d, edges: d.edges.filter((e) => e.id !== op.id) };
        break;
    }
  }
  return { diagram: d, touched, added };
}

/** El grupo más chico que contiene a esa caja (para soltar un nodo adentro de un grupo). */
export function groupAt(d: Diagram, box: { x: number; y: number; w: number; h: number }, except: Set<string>): DiagramNode | undefined {
  return d.nodes
    .filter((n) => n.shape === "group" && !except.has(n.id) && contains(n, box))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}

/** Lo que ocupan todos los nodos, con margen. */
export function bounds(d: Diagram, margin = 24): { x: number; y: number; w: number; h: number } {
  if (d.nodes.length === 0) return { x: 0, y: 0, w: 2 * margin, h: 2 * margin };
  const x = Math.min(...d.nodes.map((n) => n.x)) - margin;
  const y = Math.min(...d.nodes.map((n) => n.y)) - margin;
  const right = Math.max(...d.nodes.map((n) => n.x + n.w)) + margin;
  const bottom = Math.max(...d.nodes.map((n) => n.y + n.h)) + margin;
  return { x, y, w: right - x, h: bottom - y };
}

export function serializeDiagram(d: Diagram): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

/**
 * Un diagrama leído de un archivo. Lo que no se entiende se descarta en vez de romper: un
 * archivo editado a mano con un nodo mal escrito se sigue abriendo.
 */
export function parseDiagram(text: string): Diagram {
  let raw: { title?: unknown; nodes?: unknown; edges?: unknown } = {};
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error("El archivo no es un diagrama válido (no es JSON)");
  }
  const nodes: DiagramNode[] = [];
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const n = item as Partial<DiagramNode> | null;
    if (!n || typeof n.id !== "string" || ![n.x, n.y, n.w, n.h].every(finite)) continue;
    if (nodes.some((m) => m.id === n.id)) continue;
    nodes.push({
      id: n.id,
      shape: isShape(n.shape) ? n.shape : "rect",
      label: typeof n.label === "string" ? n.label : "",
      x: n.x!, y: n.y!, w: Math.max(MIN_NODE.w, n.w!), h: Math.max(MIN_NODE.h, n.h!),
      ...(isColor(n.color) && n.color !== "default" ? { color: n.color } : {}),
      ...(typeof n.parent === "string" ? { parent: n.parent } : {}),
    });
  }
  // Un padre que no existe o que no es grupo se olvida.
  for (const n of nodes) {
    if (n.parent && !nodes.some((p) => p.id === n.parent && p.shape === "group" && p.id !== n.id)) delete n.parent;
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = [];
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const e = item as Partial<DiagramEdge> | null;
    if (!e || typeof e.id !== "string" || !ids.has(e.from as string) || !ids.has(e.to as string)) continue;
    if (ids.has(e.id) || edges.some((x) => x.id === e.id)) continue;
    edges.push({
      id: e.id, from: e.from!, to: e.to!,
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
      ...(ARROWS.includes(e.arrow as Arrow) ? { arrow: e.arrow } : {}),
      ...(STYLES.includes(e.style as LineStyle) ? { style: e.style } : {}),
      ...(ROUTES.includes(e.route as Route) ? { route: e.route } : {}),
      ...(isColor(e.color) && e.color !== "default" ? { color: e.color } : {}),
    });
  }
  return { version: 1, ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}), nodes, edges };
}
