import { describe, expect, it } from "vitest";

import { applyOps, arrange, freeSpot, parsePage, pageData, type CanvasNode, type CanvasPage } from "../model";

const page = (id: string, nodes: CanvasNode[] = [], name = id): CanvasPage => ({ id, name, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, kind: "note", text: "", x, y, w: 200, h: 100, ...extra });

describe("applyOps", () => {
  it("una página nueva empieza vacía", () => {
    const { pages } = applyOps([], [{ op: "page.create", id: "p1", name: "Backend" }]);
    expect(pages).toEqual([page("p1", [], "Backend")]);
  });

  it("encuentra las páginas por id o por nombre, sin importar mayúsculas", () => {
    const { pages } = applyOps([page("p1", [], "Backend")], [{ op: "page.rename", page: "backend", name: "API" }]);
    expect(pages[0]!.name).toBe("API");
  });

  it("si una operación falla no se aplica ninguna", () => {
    const before = [page("p1")];
    expect(() => applyOps(before, [
      { op: "node.add", page: "p1", id: "n1", spec: { kind: "note", text: "hola" } },
      { op: "node.update", page: "p1", id: "nope", patch: { x: 3 } },
    ])).toThrow(/nope/);
    expect(before[0]!.nodes).toEqual([]);
  });

  it("un agente está en una sola página: agregarlo en otra lo muda", () => {
    const start = [page("a", [node("n1", 0, 0, { kind: "agent", ref: "tab1" })]), page("b")];
    const { pages, added } = applyOps(start, [{ op: "node.add", page: "b", id: "n2", spec: { kind: "agent", ref: "tab1" } }]);
    expect(pages[0]!.nodes).toEqual([]);
    expect(pages[1]!.nodes.map((n) => n.ref)).toEqual(["tab1"]);
    expect(added).toEqual(["n2"]);
  });

  it("agregar un agente donde ya está devuelve el nodo que ya tenía", () => {
    const start = [page("a", [node("n1", 0, 0, { kind: "agent", ref: "tab1" })])];
    const { pages, added } = applyOps(start, [{ op: "node.add", page: "a", id: "n2", spec: { kind: "agent", ref: "tab1" } }]);
    expect(pages[0]!.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(added).toEqual(["n1"]);
  });

  it("un nodo sin caja va a un lugar libre, y al lado del que se pida", () => {
    const start = [page("a", [node("n1", 0, 0)])];
    const { pages } = applyOps(start, [{ op: "node.add", page: "a", id: "n2", spec: { kind: "note", near: "n1", w: 200, h: 100 } }]);
    const added = pages[0]!.nodes[1]!;
    expect(added.x).toBeGreaterThanOrEqual(200);
    expect(added.y).toBe(0);
  });

  it("no deja achicar un nodo por debajo de su mínimo, y redondea", () => {
    const start = [page("a", [node("n1", 0, 0)])];
    const { pages, touched } = applyOps(start, [{ op: "node.update", page: "a", id: "n1", patch: { w: 10, h: 10.4, x: 3.6 } }]);
    expect(pages[0]!.nodes[0]).toMatchObject({ x: 4, w: 140, h: 90 });
    expect(touched).toEqual(["n1"]);
  });

  it("solo las notas tienen texto", () => {
    const start = [page("a", [node("n1", 0, 0, { kind: "browser", ref: "v1" })])];
    expect(() => applyOps(start, [{ op: "node.update", page: "a", id: "n1", patch: { text: "x" } }])).toThrow(/nota/);
  });

  it("mudar un nodo de página lo ubica libre en la otra", () => {
    const start = [page("a", [node("n1", 500, 500)]), page("b", [node("n2", 0, 0)])];
    const { pages } = applyOps(start, [{ op: "node.toPage", page: "a", id: "n1", to: "b" }]);
    expect(pages[0]!.nodes).toEqual([]);
    const moved = pages[1]!.nodes.find((n) => n.id === "n1")!;
    expect(moved.x === 0 && moved.y === 0).toBe(false);
  });

  it("mover una página la deja en esa posición", () => {
    const { pages } = applyOps([page("a"), page("b"), page("c")], [{ op: "page.move", page: "c", index: 0 }]);
    expect(pages.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("un viewport inválido se ignora", () => {
    const { pages } = applyOps([page("a")], [{ op: "page.viewport", page: "a", viewport: { x: Number.NaN, y: 0, zoom: 1 } }]);
    expect(pages[0]!.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("freeSpot", () => {
  it("en una página vacía, el origen", () => {
    expect(freeSpot([], 100, 100)).toEqual({ x: 0, y: 0 });
  });

  it("nunca encima de otro", () => {
    const nodes = [node("a", 0, 0), node("b", 240, 0)];
    const spot = freeSpot(nodes, 200, 100);
    const hit = nodes.some((n) => spot.x < n.x + n.w && spot.x + 200 > n.x && spot.y < n.y + n.h && spot.y + 100 > n.y);
    expect(hit).toBe(false);
  });
});

describe("arrange", () => {
  it("en grilla, por orden de lectura y sin solaparse", () => {
    const nodes = [node("c", 900, 900), node("a", 0, 0), node("b", 300, 10), node("d", 50, 600)];
    const out = arrange(nodes, "grid");
    const byId = Object.fromEntries(out.map((n) => [n.id, n]));
    expect(byId.a).toMatchObject({ x: 0, y: 0 });
    expect(byId.b).toMatchObject({ x: 240, y: 0 });
    expect(byId.d!.y).toBe(140);
    expect(byId.c!.y).toBe(140);
  });

  it("en fila, todos a la misma altura", () => {
    const out = arrange([node("a", 0, 0), node("b", 0, 500)], "row");
    expect(new Set(out.map((n) => n.y)).size).toBe(1);
  });
});

describe("persistencia", () => {
  it("ida y vuelta", () => {
    const p = page("a", [node("n1", 1, 2)]);
    expect(parsePage("a", "a", pageData(p))).toEqual(p);
  });

  it("descarta lo que no entiende en vez de romper", () => {
    const parsed = parsePage("a", "A", JSON.stringify({ nodes: [{ id: "x", kind: "raro", x: 0, y: 0, w: 1, h: 1 }, null], viewport: { zoom: 0 } }));
    expect(parsed).toEqual(page("a", [], "A"));
    expect(parsePage("a", "A", "{no es json").nodes).toEqual([]);
  });
});

describe("canvasKindOf", () => {
  it("un diagrama, un documento o una presentación (por su carpeta o cualquier archivo de adentro)", async () => {
    const { canvasKindOf } = await import("../fileKinds");
    expect(canvasKindOf("/p/docs/diagrams/a.diagram.json", false)).toEqual({ kind: "diagram", ref: "/p/docs/diagrams/a.diagram.json" });
    expect(canvasKindOf("/p/docs/informe.md", false)).toEqual({ kind: "doc", ref: "/p/docs/informe.md" });
    expect(canvasKindOf("/p/docs/slides/demo.slides", true)).toEqual({ kind: "slides", ref: "/p/docs/slides/demo.slides" });
    expect(canvasKindOf("/p/docs/slides/demo.slides/02-x.html", false)).toEqual({ kind: "slides", ref: "/p/docs/slides/demo.slides" });
    expect(canvasKindOf("/p/src/app.ts", false)).toBeNull();
    expect(canvasKindOf("/p/src", true)).toBeNull();
  });
});
