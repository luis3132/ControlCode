/**
 * Acomodar un diagrama solo, con ELK (el motor de layout que usan draw.io y muchos otros).
 *
 * Es lo que hace que un agente dibuje bien: crea las cajas y las flechas sin coordenadas y
 * pide `layout`, en vez de calcular a mano dónde va cada cosa. Los grupos se acomodan con lo
 * que tienen adentro y crecen para contenerlo.
 */
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";

import type { Diagram, DiagramNode } from "./model";
import { FONT_SIZE, LINE_HEIGHT, textWidth } from "./shapes";

export type LayoutDirection = "LR" | "TB" | "RL" | "BT";

const DIRECTION: Record<LayoutDirection, string> = { LR: "RIGHT", TB: "DOWN", RL: "LEFT", BT: "UP" };

let elk: InstanceType<typeof ELK> | null = null;

/** Lo que queda entre cajas. Va también en cada grupo: adentro de uno, ELK no hereda el
 *  espaciado de afuera y las cajas quedaban pegadas. */
const SPACING = {
  "elk.spacing.nodeNode": "50",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.layered.spacing.edgeNodeBetweenLayers": "30",
  "elk.spacing.edgeNode": "30",
  "elk.edgeLabels.placement": "CENTER",
};

export async function layoutDiagram(diagram: Diagram, direction: LayoutDirection = "LR"): Promise<Diagram> {
  if (diagram.nodes.length === 0) return diagram;
  elk ??= new ELK();
  const children = (parent: string | undefined): DiagramNode[] => diagram.nodes.filter((n) => n.parent === parent);

  const toElk = (node: DiagramNode): ElkNode => {
    const inner = children(node.id);
    if (node.shape === "group" && inner.length > 0) {
      return {
        id: node.id,
        layoutOptions: { ...SPACING, "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
        children: inner.map(toElk),
      };
    }
    return { id: node.id, width: node.w, height: node.h };
  };

  // Flechas a todo nivel: ELK las rutea a través de los grupos. Con su etiqueta medida,
  // para que deje lugar entre las cajas y el texto no tape la flecha.
  const edges: ElkExtendedEdge[] = diagram.edges
    .filter((e) => e.from !== e.to)
    .map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      ...(e.label
        ? {
          labels: [{
            text: e.label,
            width: Math.max(...e.label.split("\n").map((l) => textWidth(l, FONT_SIZE - 1))) + 16,
            height: e.label.split("\n").length * LINE_HEIGHT + 4,
          }],
        }
        : {}),
    }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": DIRECTION[direction],
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      ...SPACING,
    },
    children: children(undefined).map(toElk),
    edges,
  };

  const result = await elk.layout(graph);

  // ELK da cada posición relativa a su padre; acá todo va en absoluto.
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      placed.set(child.id, { x, y, w: child.width ?? 0, h: child.height ?? 0 });
      walk(child, x, y);
    }
  };
  walk(result, 0, 0);

  return {
    ...diagram,
    nodes: diagram.nodes.map((n) => {
      const p = placed.get(n.id);
      if (!p) return n;
      const isGroup = n.shape === "group" && children(n.id).length > 0;
      return { ...n, x: Math.round(p.x), y: Math.round(p.y), ...(isGroup ? { w: Math.round(p.w), h: Math.round(p.h) } : {}) };
    }),
  };
}
