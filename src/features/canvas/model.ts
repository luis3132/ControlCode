/**
 * El canvas de un workspace: páginas con nodos que se mueven, y las operaciones que los
 * cambian.
 *
 * ## Una sola vía para cambiarlo
 *
 * Todo cambio —arrastrar un nodo, crear una página, lo que pide un agente por el MCP— es
 * una operación (`CanvasOp`) que pasa por `applyOps`. Así no puede haber algo que el
 * usuario haga y un agente no (o al revés), y cada operación sabe qué nodos tocó: es lo que
 * deja pintar con el color de cada agente lo que está cambiando.
 *
 * Puro: sin stores ni IPC, se prueba en Node (`tests/model.test.ts`).
 */

export type CanvasNodeKind = "agent" | "browser" | "note" | "diagram";

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  /** La tab de agente (`agent`), la vista de navegador (`browser`) o la ruta del archivo
   *  (`diagram`) que muestra. */
  ref?: string;
  /** El texto de una nota. */
  text?: string;
  /** Un nombre propio. Sin él se muestra el de la tab o la página. */
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasPage {
  id: string;
  name: string;
  nodes: CanvasNode[];
  viewport: Viewport;
}

/** Lo que se pide al agregar un nodo. Sin caja, se busca un lugar libre. */
export interface NodeSpec {
  kind: CanvasNodeKind;
  ref?: string;
  text?: string;
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Ubicarlo al lado de este nodo. */
  near?: string;
}

export interface NodePatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  title?: string;
  text?: string;
}

export type ArrangeLayout = "grid" | "row" | "column";

export type CanvasOp =
  | { op: "page.create"; id: string; name: string }
  | { op: "page.rename"; page: string; name: string }
  | { op: "page.remove"; page: string }
  | { op: "page.move"; page: string; index: number }
  | { op: "page.viewport"; page: string; viewport: Viewport }
  | { op: "page.arrange"; page: string; layout: ArrangeLayout }
  | { op: "node.add"; page: string; id: string; spec: NodeSpec }
  | { op: "node.update"; page: string; id: string; patch: NodePatch }
  | { op: "node.remove"; page: string; id: string }
  | { op: "node.toPage"; page: string; id: string; to: string };

export interface ApplyResult {
  pages: CanvasPage[];
  /** Los nodos creados, cambiados o movidos, para pintarlos del color de quien los tocó.
   *  Un nodo agregado que ya estaba (el mismo agente) vuelve con su id de antes. */
  touched: string[];
  /** Por cada `node.add`, el id con que quedó el nodo. */
  added: string[];
}

export const DEFAULT_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  agent: { w: 760, h: 460 },
  browser: { w: 960, h: 620 },
  note: { w: 280, h: 200 },
  diagram: { w: 900, h: 600 },
};

/** El alto de la cabecera de un nodo, por donde se agarra. Lo de abajo es su contenido. */
export const NODE_HEADER = 30;

/** Lo que queda entre nodos al ubicarlos solos. */
export const GAP = 40;

/** Lo mínimo a lo que se puede achicar un nodo. */
export const MIN_SIZE: Record<CanvasNodeKind, { w: number; h: number }> = {
  agent: { w: 320, h: 180 },
  browser: { w: 320, h: 220 },
  note: { w: 140, h: 90 },
  diagram: { w: 320, h: 220 },
};

export const EMPTY_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** Una página por id, o por nombre sin importar mayúsculas (lo que escribe un agente). */
export function findPage(pages: CanvasPage[], key: string): CanvasPage | undefined {
  const lower = key.trim().toLowerCase();
  return pages.find((p) => p.id === key) ?? pages.find((p) => p.name.trim().toLowerCase() === lower);
}

function requirePage(pages: CanvasPage[], key: string): CanvasPage {
  const page = findPage(pages, key);
  if (!page) throw new Error(`No hay ninguna página '${key}'. Páginas: ${pages.map((p) => `${p.name} (${p.id})`).join(", ") || "ninguna"}`);
  return page;
}

function requireNode(page: CanvasPage, id: string): CanvasNode {
  const node = page.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`La página '${page.name}' no tiene ningún nodo '${id}': leé el canvas de nuevo (canvas_read).`);
  return node;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: CanvasNode): boolean {
  return a.x < b.x + b.w + GAP / 2 && a.x + a.w + GAP / 2 > b.x && a.y < b.y + b.h + GAP / 2 && a.y + a.h + GAP / 2 > b.y;
}

/**
 * Dónde poner un nodo de ese tamaño sin tapar a nadie. Al lado de `near` si se puede (a la
 * derecha, si no abajo); si no, el primer hueco de una grilla que se recorre por filas.
 */
export function freeSpot(nodes: CanvasNode[], w: number, h: number, near?: CanvasNode): { x: number; y: number } {
  const free = (x: number, y: number) => !nodes.some((n) => overlaps({ x, y, w, h }, n));
  if (near) {
    const candidates = [
      { x: near.x + near.w + GAP, y: near.y },
      { x: near.x, y: near.y + near.h + GAP },
      { x: near.x - w - GAP, y: near.y },
      { x: near.x, y: near.y - h - GAP },
    ];
    const spot = candidates.find((c) => free(c.x, c.y));
    if (spot) return spot;
  }
  if (nodes.length === 0) return { x: 0, y: 0 };
  // Pegado a lo que ya hay: a la derecha de algún nodo, empezando por los de arriba; si no,
  // debajo. Así lo nuevo aparece cerca de donde se está trabajando y no en un hueco lejano.
  const byReading = readingOrder(nodes);
  for (const n of byReading) {
    const spot = { x: n.x + n.w + GAP, y: n.y };
    if (free(spot.x, spot.y)) return spot;
  }
  for (const n of byReading) {
    const spot = { x: n.x, y: n.y + n.h + GAP };
    if (free(spot.x, spot.y)) return spot;
  }
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const stepX = Math.max(w, 200) + GAP;
  const stepY = Math.max(h, 150) + GAP;
  for (let row = 0; row < 200; row++) {
    for (let col = 0; col < 6; col++) {
      const x = left + col * stepX;
      const y = top + row * stepY;
      if (free(x, y)) return { x, y };
    }
  }
  // No debería pasar nunca: abajo de todo.
  return { x: left, y: Math.max(...nodes.map((n) => n.y + n.h)) + GAP };
}

/** En orden de lectura: de arriba abajo y de izquierda a derecha, por filas aproximadas. */
function readingOrder(nodes: CanvasNode[]): CanvasNode[] {
  return [...nodes].sort((a, b) => (Math.abs(a.y - b.y) > 80 ? a.y - b.y : a.x - b.x));
}

/** Los nodos acomodados sin solaparse, cada uno con su tamaño, desde la esquina de arriba
 *  a la izquierda de los que ya estaban. */
export function arrange(nodes: CanvasNode[], layout: ArrangeLayout): CanvasNode[] {
  if (nodes.length === 0) return nodes;
  const ordered = readingOrder(nodes);
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const columns = layout === "row" ? ordered.length : layout === "column" ? 1 : Math.ceil(Math.sqrt(ordered.length));
  const placed = new Map<string, { x: number; y: number }>();
  let y = top;
  for (let start = 0; start < ordered.length; start += columns) {
    const row = ordered.slice(start, start + columns);
    let x = left;
    for (const node of row) {
      placed.set(node.id, { x, y });
      x += node.w + GAP;
    }
    y += Math.max(...row.map((n) => n.h)) + GAP;
  }
  return nodes.map((n) => {
    const at = placed.get(n.id)!;
    return at.x === n.x && at.y === n.y ? n : { ...n, ...at };
  });
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function clampSize(kind: CanvasNodeKind, w: number, h: number): { w: number; h: number } {
  const min = MIN_SIZE[kind];
  return { w: Math.max(min.w, Math.round(w)), h: Math.max(min.h, Math.round(h)) };
}

/**
 * Aplica las operaciones en orden. Si una falla no se aplica ninguna: un agente que manda
 * cinco cambios y uno tiene un id viejo no deja el canvas a medias.
 */
export function applyOps(pages: CanvasPage[], ops: CanvasOp[]): ApplyResult {
  let next = pages;
  const touched: string[] = [];
  const added: string[] = [];

  const setPage = (id: string, fn: (page: CanvasPage) => CanvasPage) => {
    next = next.map((p) => (p.id === id ? fn(p) : p));
  };

  for (const op of ops) {
    switch (op.op) {
      case "page.create": {
        if (next.some((p) => p.id === op.id)) throw new Error(`Ya hay una página con id ${op.id}`);
        next = [...next, { id: op.id, name: op.name.trim() || op.id, nodes: [], viewport: EMPTY_VIEWPORT }];
        break;
      }
      case "page.rename": {
        const page = requirePage(next, op.page);
        const name = op.name.trim();
        if (!name) throw new Error("El nombre de la página no puede quedar vacío");
        setPage(page.id, (p) => ({ ...p, name }));
        break;
      }
      case "page.remove": {
        const page = requirePage(next, op.page);
        next = next.filter((p) => p.id !== page.id);
        break;
      }
      case "page.move": {
        const page = requirePage(next, op.page);
        const rest = next.filter((p) => p.id !== page.id);
        const index = Math.max(0, Math.min(rest.length, Math.round(op.index)));
        next = [...rest.slice(0, index), page, ...rest.slice(index)];
        break;
      }
      case "page.viewport": {
        const page = requirePage(next, op.page);
        const { x, y, zoom } = op.viewport;
        if (![x, y, zoom].every(finite) || zoom <= 0) break;
        setPage(page.id, (p) => ({ ...p, viewport: { x, y, zoom } }));
        break;
      }
      case "page.arrange": {
        const page = requirePage(next, op.page);
        const nodes = arrange(page.nodes, op.layout);
        nodes.forEach((n, i) => n !== page.nodes[i] && touched.push(n.id));
        setPage(page.id, (p) => ({ ...p, nodes }));
        break;
      }
      case "node.add": {
        const page = requirePage(next, op.page);
        const { spec } = op;
        if (spec.kind !== "note" && !spec.ref) {
          throw new Error(`Un nodo '${spec.kind}' necesita qué mostrar`);
        }
        // Un agente está en una sola página: agregarlo donde ya está devuelve ese nodo, y
        // agregarlo a otra lo muda.
        if (spec.kind === "agent") {
          const here = page.nodes.find((n) => n.kind === "agent" && n.ref === spec.ref);
          if (here) {
            added.push(here.id);
            touched.push(here.id);
            break;
          }
          next = next.map((p) => (p.id === page.id ? p : { ...p, nodes: p.nodes.filter((n) => !(n.kind === "agent" && n.ref === spec.ref)) }));
        }
        const target = next.find((p) => p.id === page.id)!;
        const size = clampSize(spec.kind, spec.w ?? DEFAULT_SIZE[spec.kind].w, spec.h ?? DEFAULT_SIZE[spec.kind].h);
        const near = spec.near ? target.nodes.find((n) => n.id === spec.near) : undefined;
        if (spec.near && !near) throw new Error(`La página '${target.name}' no tiene ningún nodo '${spec.near}'`);
        const at = finite(spec.x) && finite(spec.y)
          ? { x: Math.round(spec.x), y: Math.round(spec.y) }
          : freeSpot(target.nodes, size.w, size.h, near);
        const node: CanvasNode = {
          id: op.id,
          kind: spec.kind,
          ...(spec.ref ? { ref: spec.ref } : {}),
          ...(spec.kind === "note" ? { text: spec.text ?? "" } : {}),
          ...(spec.title?.trim() ? { title: spec.title.trim() } : {}),
          ...at,
          ...size,
        };
        setPage(target.id, (p) => ({ ...p, nodes: [...p.nodes, node] }));
        added.push(node.id);
        touched.push(node.id);
        break;
      }
      case "node.update": {
        const page = requirePage(next, op.page);
        const node = requireNode(page, op.id);
        const { patch } = op;
        const updated: CanvasNode = { ...node };
        if (finite(patch.x)) updated.x = Math.round(patch.x);
        if (finite(patch.y)) updated.y = Math.round(patch.y);
        if (finite(patch.w) || finite(patch.h)) {
          Object.assign(updated, clampSize(node.kind, finite(patch.w) ? patch.w : node.w, finite(patch.h) ? patch.h : node.h));
        }
        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (title) updated.title = title;
          else delete updated.title;
        }
        if (patch.text !== undefined) {
          if (node.kind !== "note") throw new Error(`El nodo '${node.id}' no es una nota: no tiene texto`);
          updated.text = patch.text;
        }
        setPage(page.id, (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === node.id ? updated : n)) }));
        touched.push(node.id);
        break;
      }
      case "node.remove": {
        const page = requirePage(next, op.page);
        requireNode(page, op.id);
        setPage(page.id, (p) => ({ ...p, nodes: p.nodes.filter((n) => n.id !== op.id) }));
        break;
      }
      case "node.toPage": {
        const from = requirePage(next, op.page);
        const node = requireNode(from, op.id);
        const to = requirePage(next, op.to);
        if (to.id === from.id) break;
        const at = freeSpot(to.nodes, node.w, node.h);
        setPage(from.id, (p) => ({ ...p, nodes: p.nodes.filter((n) => n.id !== node.id) }));
        setPage(to.id, (p) => ({ ...p, nodes: [...p.nodes, { ...node, ...at }] }));
        touched.push(node.id);
        break;
      }
    }
  }
  return { pages: next, touched, added };
}

/** La página donde está ese agente, si está en alguna. */
export function pageOfAgent(pages: CanvasPage[], tabId: string): CanvasPage | undefined {
  return pages.find((p) => p.nodes.some((n) => n.kind === "agent" && n.ref === tabId));
}

/** Lo que se guarda de una página además de su nombre: sus nodos y su viewport. */
export function pageData(page: CanvasPage): string {
  return JSON.stringify({ nodes: page.nodes, viewport: page.viewport });
}

/** Una página leída de la base. Lo que no se entienda se descarta en vez de romper. */
export function parsePage(id: string, name: string, data: string): CanvasPage {
  let raw: { nodes?: unknown; viewport?: unknown } = {};
  try {
    raw = JSON.parse(data) as typeof raw;
  } catch {
    /* una página ilegible se abre vacía */
  }
  const kinds: CanvasNodeKind[] = ["agent", "browser", "note", "diagram"];
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter((n): n is CanvasNode => {
    const node = n as Partial<CanvasNode> | null;
    return !!node && typeof node.id === "string" && kinds.includes(node.kind as CanvasNodeKind)
      && [node.x, node.y, node.w, node.h].every(finite);
  });
  const v = raw.viewport as Partial<Viewport> | undefined;
  const viewport = v && finite(v.x) && finite(v.y) && finite(v.zoom) && v.zoom > 0 ? { x: v.x, y: v.y, zoom: v.zoom } : EMPTY_VIEWPORT;
  return { id, name, nodes, viewport };
}
