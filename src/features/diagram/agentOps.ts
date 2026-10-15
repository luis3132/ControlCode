/**
 * Lo que un agente manda y recibe sobre un diagrama, como texto y operaciones. Puro: se
 * prueba en Node.
 */
import type { Diagram, DiagramOp, EdgeInput, NodeInput } from "./model";

const str = (r: Record<string, unknown>, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);

const NODE_KEYS = ["id", "shape", "label", "color", "parent", "x", "y", "w", "h"] as const;
const EDGE_KEYS = ["id", "from", "to", "label", "arrow", "style", "route", "color"] as const;

function pick<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> {
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) as Record<K, unknown>;
}

/** Las operaciones como las escribe un agente (`add_node`…), como operaciones del modelo. */
export function toDiagramOps(raw: unknown[]): DiagramOp[] {
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = str(o, "id");
    const need = () => {
      if (!id) throw new Error(`La operación ${i + 1} (${String(o.op)}) necesita 'id'`);
      return id;
    };
    switch (o.op) {
      case "add_node": return { op: "node.add", node: pick(o, NODE_KEYS) as NodeInput };
      case "update_node": {
        const { id: _, ...patch } = pick(o, NODE_KEYS);
        return { op: "node.update", id: need(), patch: patch as NodeInput };
      }
      case "remove_node": return { op: "node.remove", id: need() };
      case "add_edge": return { op: "edge.add", edge: pick(o, EDGE_KEYS) as EdgeInput };
      case "update_edge": {
        const { id: _, ...patch } = pick(o, EDGE_KEYS);
        return { op: "edge.update", id: need(), patch: patch as EdgeInput };
      }
      case "remove_edge": return { op: "edge.remove", id: need() };
      default:
        throw new Error(`Operación ${i + 1}: '${String(o.op)}' no existe. Son add_node, update_node, remove_node, add_edge, update_edge y remove_edge`);
    }
  });
}

/** El diagrama como texto para el agente: lo justo para seguir editándolo. */
export function describeDiagram(d: Diagram, path: string): string {
  const lines = [`Diagram ${path}${d.title ? ` "${d.title}"` : ""}: ${d.nodes.length} node(s), ${d.edges.length} arrow(s).`];
  for (const n of d.nodes) {
    const extras = [n.color && `color=${n.color}`, n.parent && `in=${n.parent}`].filter(Boolean).join(" ");
    lines.push(`- ${n.id} ${n.shape} ${JSON.stringify(n.label)} at (${n.x}, ${n.y}) ${n.w}×${n.h}${extras ? ` ${extras}` : ""}`);
  }
  for (const e of d.edges) {
    const extras = [
      e.arrow && e.arrow !== "end" && `arrow=${e.arrow}`, e.style === "dashed" && "dashed",
      e.route && e.route !== "orthogonal" && `route=${e.route}`, e.color && `color=${e.color}`,
    ].filter(Boolean).join(" ");
    lines.push(`- ${e.id} ${e.from} → ${e.to}${e.label ? ` ${JSON.stringify(e.label)}` : ""}${extras ? ` ${extras}` : ""}`);
  }
  return lines.join("\n");
}
