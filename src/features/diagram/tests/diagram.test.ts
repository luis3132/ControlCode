import { describe, expect, it } from "vitest";

import { toDrawio } from "../drawio";
import { layoutDiagram } from "../layout";
import { applyDiagramOps, EMPTY_DIAGRAM, parseDiagram, serializeDiagram, SHAPES, type Diagram } from "../model";
import { edgeGeometry, edgeSides, labelLines, shapeOutline, wrapText } from "../shapes";
import { toSvg } from "../svg";

const build = (...ops: Parameters<typeof applyDiagramOps>[1]) => applyDiagramOps(EMPTY_DIAGRAM, ops).diagram;

describe("applyDiagramOps", () => {
  it("las operaciones de un lote se ven entre sí: crear dos nodos y unirlos", () => {
    const { diagram, added } = applyDiagramOps(EMPTY_DIAGRAM, [
      { op: "node.add", node: { id: "api", label: "API" } },
      { op: "node.add", node: { id: "db", shape: "cylinder", label: "Postgres" } },
      { op: "edge.add", edge: { from: "api", to: "db", label: "SQL" } },
    ]);
    expect(added).toEqual(["api", "db", "e1"]);
    expect(diagram.edges).toEqual([{ id: "e1", from: "api", to: "db", label: "SQL" }]);
  });

  it("sin coordenadas, cada nodo va a un lugar libre", () => {
    const d = build({ op: "node.add", node: { label: "a" } }, { op: "node.add", node: { label: "b" } });
    const [a, b] = d.nodes;
    expect(a!.x + a!.w).toBeLessThanOrEqual(b!.x);
  });

  it("si una falla no se aplica ninguna, y el error dice qué hay", () => {
    expect(() => applyDiagramOps(EMPTY_DIAGRAM, [
      { op: "node.add", node: { id: "a" } },
      { op: "edge.add", edge: { from: "a", to: "nope" } },
    ])).toThrow(/nope.*Nodos: a/);
  });

  it("rechaza formas, colores y flechas que no existen", () => {
    expect(() => build({ op: "node.add", node: { shape: "star" as never } })).toThrow(/Forma/);
    expect(() => build({ op: "node.add", node: { color: "pink" as never } })).toThrow(/Color/);
    const d = build({ op: "node.add", node: { id: "a" } });
    expect(() => applyDiagramOps(d, [{ op: "edge.add", edge: { from: "a", to: "a", arrow: "sideways" as never } }])).toThrow(/arrow/);
  });

  it("mover un grupo mueve lo que tiene adentro", () => {
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group", x: 0, y: 0, w: 400, h: 300 } },
      { op: "node.add", node: { id: "a", x: 20, y: 50, parent: "g" } },
    );
    const moved = applyDiagramOps(d, [{ op: "node.update", id: "g", patch: { x: 100, y: 10 } }]).diagram;
    expect(moved.nodes.find((n) => n.id === "a")).toMatchObject({ x: 120, y: 60 });
  });

  it("solo un grupo contiene, y nada se contiene a sí mismo", () => {
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group" } },
      { op: "node.add", node: { id: "h", shape: "group", parent: "g" } },
      { op: "node.add", node: { id: "a" } },
    );
    expect(() => applyDiagramOps(d, [{ op: "node.update", id: "g", patch: { parent: "a" } }])).toThrow(/grupo/);
    expect(() => applyDiagramOps(d, [{ op: "node.update", id: "g", patch: { parent: "h" } }])).toThrow(/sí mismo/);
  });

  it("borrar un nodo borra sus flechas; borrar un grupo suelta lo de adentro", () => {
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group" } },
      { op: "node.add", node: { id: "a", parent: "g" } },
      { op: "node.add", node: { id: "b" } },
      { op: "edge.add", edge: { from: "a", to: "b" } },
    );
    const noGroup = applyDiagramOps(d, [{ op: "node.remove", id: "g" }]).diagram;
    expect(noGroup.nodes.find((n) => n.id === "a")!.parent).toBeUndefined();
    const noA = applyDiagramOps(d, [{ op: "node.remove", id: "a" }]).diagram;
    expect(noA.edges).toEqual([]);
  });

  it("un id repetido no se acepta", () => {
    const d = build({ op: "node.add", node: { id: "a" } });
    expect(() => applyDiagramOps(d, [{ op: "edge.add", edge: { id: "a", from: "a", to: "a" } }])).toThrow(/id 'a'/);
  });
});

describe("archivo", () => {
  it("ida y vuelta", () => {
    const d = build(
      { op: "title", title: "Arquitectura" },
      { op: "node.add", node: { id: "a", label: "Web", color: "blue" } },
      { op: "node.add", node: { id: "b", shape: "cylinder" } },
      { op: "edge.add", edge: { from: "a", to: "b", style: "dashed", arrow: "both" } },
    );
    expect(parseDiagram(serializeDiagram(d))).toEqual(d);
  });

  it("descarta lo que no entiende sin romper, y lo que no es JSON lo dice", () => {
    const parsed = parseDiagram(JSON.stringify({
      nodes: [{ id: "a", x: 0, y: 0, w: 10, h: 10, shape: "raro", parent: "fantasma" }, { id: "b" }],
      edges: [{ id: "e", from: "a", to: "nadie" }],
    }));
    expect(parsed.nodes).toEqual([{ id: "a", shape: "rect", label: "", x: 0, y: 0, w: 30, h: 24 }]);
    expect(parsed.edges).toEqual([]);
    expect(() => parseDiagram("{roto")).toThrow(/JSON/);
  });
});

describe("dibujo", () => {
  it("cada forma tiene contorno", () => {
    for (const shape of SHAPES) expect(shapeOutline(shape, 100, 60).d).toMatch(/^M/);
  });

  it("parte el texto en las líneas que entran, respetando los saltos", () => {
    expect(wrapText("uno dos tres cuatro", 60)).toEqual(["uno dos", "tres", "cuatro"]);
    expect(wrapText("a\nb", 500)).toEqual(["a", "b"]);
  });

  it("lo que no entra se corta con puntos suspensivos", () => {
    const { lines } = labelLines({ shape: "rect", label: "una frase bastante larga que no entra en la caja", w: 80, h: 30 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  it("una flecha sale por los lados que se miran", () => {
    expect(edgeSides({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 10, w: 100, h: 50 })).toEqual(["right", "left"]);
    expect(edgeSides({ x: 0, y: 0, w: 100, h: 50 }, { x: 10, y: 200, w: 100, h: 50 })).toEqual(["bottom", "top"]);
  });

  it("en escalera, dobla a mitad de camino", () => {
    const geo = edgeGeometry({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 100, w: 100, h: 50 }, "orthogonal");
    expect(geo.path).toBe("M100,25H200V125H300");
  });

  it("el SVG tiene una forma por nodo, sus flechas con punta y escapa el texto", () => {
    const d = build(
      { op: "node.add", node: { id: "a", label: "<script>", x: 0, y: 0 } },
      { op: "node.add", node: { id: "b", x: 300, y: 0 } },
      { op: "edge.add", edge: { from: "a", to: "b" } },
    );
    const svg = toSvg(d);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("marker-end");
  });

  it("draw.io: los nodos dentro de un grupo van relativos a él, con su flecha", () => {
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group", x: 100, y: 100, w: 300, h: 200, label: "VPC" } },
      { op: "node.add", node: { id: "a", x: 130, y: 150, parent: "g", label: "API" } },
      { op: "node.add", node: { id: "b", x: 600, y: 150 } },
      { op: "edge.add", edge: { from: "a", to: "b" } },
    );
    const xml = toDrawio(d);
    expect(xml).toContain('parent="n-g"><mxGeometry x="30" y="50"');
    expect(xml).toContain('source="n-a" target="n-b"');
    expect(xml).toMatch(/^<mxfile/);
  });
});

describe("layout", () => {
  it("de izquierda a derecha: cada nodo después del anterior, sin solaparse", async () => {
    const d: Diagram = build(
      { op: "node.add", node: { id: "a", x: 0, y: 0 } },
      { op: "node.add", node: { id: "b", x: 0, y: 0 } },
      { op: "node.add", node: { id: "c", x: 0, y: 0 } },
      { op: "edge.add", edge: { from: "a", to: "b" } },
      { op: "edge.add", edge: { from: "b", to: "c" } },
    );
    const out = await layoutDiagram(d, "LR");
    const [a, b, c] = ["a", "b", "c"].map((id) => out.nodes.find((n) => n.id === id)!);
    expect(a!.x + a!.w).toBeLessThan(b!.x);
    expect(b!.x + b!.w).toBeLessThan(c!.x);
  });

  it("un grupo crece para contener lo suyo", async () => {
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group", x: 0, y: 0, w: 50, h: 50 } },
      { op: "node.add", node: { id: "a", x: 0, y: 0, parent: "g" } },
      { op: "node.add", node: { id: "b", x: 0, y: 0, parent: "g" } },
      { op: "edge.add", edge: { from: "a", to: "b" } },
    );
    const out = await layoutDiagram(d, "TB");
    const g = out.nodes.find((n) => n.id === "g")!;
    for (const id of ["a", "b"]) {
      const n = out.nodes.find((x) => x.id === id)!;
      expect(n.x).toBeGreaterThanOrEqual(g.x);
      expect(n.y + n.h).toBeLessThanOrEqual(g.y + g.h);
    }
  });
});

describe("lo que manda un agente", () => {
  it("traduce sus operaciones y exige id donde hace falta", async () => {
    const { toDiagramOps } = await import("../agentOps");
    expect(toDiagramOps([
      { op: "add_node", id: "api", label: "API", shape: "rounded", extra: "ignorado" },
      { op: "add_edge", from: "api", to: "db", label: "SQL" },
      { op: "update_node", id: "api", color: "blue" },
    ])).toEqual([
      { op: "node.add", node: { id: "api", label: "API", shape: "rounded" } },
      { op: "edge.add", edge: { from: "api", to: "db", label: "SQL" } },
      { op: "node.update", id: "api", patch: { color: "blue" } },
    ]);
    expect(() => toDiagramOps([{ op: "remove_node" }])).toThrow(/id/);
    expect(() => toDiagramOps([{ op: "draw" }])).toThrow(/add_node/);
  });

  it("le describe el diagrama con lo que necesita para seguir", async () => {
    const { describeDiagram } = await import("../agentOps");
    const d = build(
      { op: "node.add", node: { id: "g", shape: "group", label: "VPC", x: 0, y: 0 } },
      { op: "node.add", node: { id: "api", label: "API", parent: "g", color: "blue", x: 10, y: 40 } },
      { op: "node.add", node: { id: "db", shape: "cylinder", x: 600, y: 0 } },
      { op: "edge.add", edge: { from: "api", to: "db", label: "SQL", style: "dashed" } },
    );
    const text = describeDiagram(d, "docs/a.diagram.json");
    expect(text).toContain('- api rounded "API" at (10, 40) 160×70 color=blue in=g');
    expect(text).toContain('- e1 api → db "SQL" dashed');
  });
});
