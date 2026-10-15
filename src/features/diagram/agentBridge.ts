import { addNode, activePageOf, centerOn, workspaceOf } from "@/features/canvas/actions";
import { findPage } from "@/features/canvas/model";
import { setActivePage, useCanvasStore, type CanvasActor } from "@/features/canvas/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { relativeTo } from "@/features/tabs/viewTabs";

import { EXPORT_FORMATS, exportDiagram, exportPath, type ExportFormat } from "./export";
import type { LayoutDirection } from "./layout";
import { describeDiagram, toDiagramOps } from "./agentOps";
import { freeDiagramPath, resolveInProject, withDiagramExtension } from "./paths";
import { createDiagram, dispatchDiagram, layoutAndCommit, loadDiagram, saveNow, useDiagramStore } from "./store";

/**
 * Un agente dibujando un diagrama, desde el MCP (`diagram_*`, ver `ipc/mcp.rs`). Llega por
 * el mismo canal que el canvas (`canvas.run`) y termina en las mismas funciones que el
 * editor, con el agente como autor.
 */

type Request = Record<string, unknown> & { op: string };

const str = (r: Record<string, unknown>, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: Record<string, unknown>, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);

export async function runDiagramRequest(cwd: string, request: Request, actor: CanvasActor | null): Promise<string> {
  const pathArg = str(request, "path");
  const resolve = (p: string) => resolveInProject(cwd, p);
  const shown = (p: string) => relativeTo(p, cwd);

  switch (request.op) {
    case "diagram.create": {
      const title = str(request, "title") ?? "Diagrama";
      const path = pathArg ? resolve(withDiagramExtension(pathArg)) : await freeDiagramPath(cwd, title);
      await createDiagram(path, title);
      const workspace = workspaceOf(cwd);
      const canvasOn = !!useCanvasStore.getState().canvasMode[workspace];
      const show = str(request, "show") ?? (canvasOn ? "canvas" : "tab");
      if (show === "canvas") {
        const pageKey = str(request, "page");
        let page = await activePageOf(workspace);
        if (pageKey) {
          const found = findPage(useCanvasStore.getState().pages[workspace] ?? [], pageKey);
          if (!found) throw new Error(`No hay ninguna página '${pageKey}'`);
          page = found;
        }
        const box = { x: num(request, "x"), y: num(request, "y"), w: num(request, "w"), h: num(request, "h"), near: str(request, "near") };
        const nodeId = addNode(workspace, page.id, { ...box, kind: "diagram", ref: path }, actor);
        if (page.id === useCanvasStore.getState().activePage[workspace] || !pageKey) setActivePage(workspace, page.id);
        centerOn(workspace, page.id, nodeId);
        return `Created ${shown(path)}, on canvas page "${page.name}" as node ${nodeId}. Now add nodes and arrows with diagram_edit.`;
      }
      if (show === "tab") useViewTabsStore.getState().openFile(cwd, path);
      return `Created ${shown(path)}${show === "tab" ? ", open in a tab" : ""}. Now add nodes and arrows with diagram_edit.`;
    }

    case "diagram.read": {
      if (!pathArg) throw new Error("Falta 'path'");
      const path = resolve(pathArg);
      return describeDiagram(await loadDiagram(path), shown(path));
    }

    case "diagram.edit": {
      if (!pathArg) throw new Error("Falta 'path'");
      const path = resolve(pathArg);
      const before = await loadDiagram(path);
      const ops = toDiagramOps(Array.isArray(request.ops) ? request.ops : []);
      const title = str(request, "title");
      if (title !== undefined) ops.unshift({ op: "title", title });
      if (ops.length === 0 && !request.layout) throw new Error("No hay nada que cambiar: pasá 'ops' o 'layout'");
      const result = ops.length > 0 ? dispatchDiagram(path, ops, actor) : null;
      // Un diagrama que empezó vacío y llegó sin coordenadas se acomoda solo.
      const placedByHand = ops.some((o) => o.op === "node.add" && o.node.x !== undefined && o.node.y !== undefined);
      const direction = (str(request, "layout") as LayoutDirection | undefined)
        ?? (before.nodes.length === 0 && !placedByHand && (result?.added.length ?? 0) > 0 ? "LR" : undefined);
      if (direction) {
        if (!["LR", "TB", "RL", "BT"].includes(direction)) throw new Error("'layout' tiene que ser LR, TB, RL o BT");
        await layoutAndCommit(path, direction, actor);
      }
      await saveNow(path);
      const d = useDiagramStore.getState().docs[path]!.diagram;
      const added = result?.added.length ? ` Added: ${result.added.join(", ")}.` : "";
      return `Applied ${ops.length} operation(s)${direction ? ` and arranged it ${direction}` : ""}.${added} The diagram now has ${d.nodes.length} node(s) and ${d.edges.length} arrow(s).`;
    }

    case "diagram.export": {
      if (!pathArg) throw new Error("Falta 'path'");
      const format = str(request, "format") as ExportFormat | undefined;
      if (!format || !EXPORT_FORMATS.includes(format)) throw new Error(`'format' tiene que ser ${EXPORT_FORMATS.join(", ")}`);
      const path = resolve(pathArg);
      const diagram = await loadDiagram(path);
      const outArg = str(request, "out");
      const out = await exportDiagram(diagram, format, outArg ? resolve(outArg) : exportPath(path, format));
      return `Exported to ${shown(out)}.`;
    }

    default:
      throw new Error(`Los diagramas no saben hacer '${request.op}'`);
  }
}
