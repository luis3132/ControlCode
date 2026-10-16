import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { relativeTo, type ViewOwner } from "@/features/tabs/viewTabs";
import { useDormant } from "@/features/terminal/hibernation";

import { activePageOf, addBrowser, addNode, agentsOf, defaultPageName, workspaceOf } from "./actions";
import { findPage, pageOfAgent, type ArrangeLayout, type CanvasNode, type CanvasOp, type CanvasPage, type NodeSpec } from "./model";
import {
  dispatchCanvas, ensureLoaded, newPageId, requestView, setActivePage, setCanvasMode, useCanvasStore, type CanvasActor,
} from "./store";

/**
 * Un agente manejando el canvas de su workspace, desde el MCP (`canvas_*`, ver
 * `ipc/mcp.rs`). Todo termina en las mismas funciones que usa la interfaz, con el agente
 * como autor: lo que toca queda pintado de su color.
 */

export interface CanvasRequest {
  op: string;
  [key: string]: unknown;
}

export interface CanvasDeps {
  /** Crea una tab de agente como `ccode tab create` y devuelve su id. */
  createTab: (agent: string) => Promise<string>;
}

const str = (r: CanvasRequest, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: CanvasRequest, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);

function boxOf(r: CanvasRequest): Partial<NodeSpec> {
  return { x: num(r, "x"), y: num(r, "y"), w: num(r, "w"), h: num(r, "h"), near: str(r, "near") };
}

export async function runCanvasRequest(cwd: string, request: CanvasRequest, owner: ViewOwner | null, deps: CanvasDeps): Promise<string> {
  const workspace = workspaceOf(cwd);
  await ensureLoaded(workspace);
  const actor: CanvasActor | null = owner ? { id: owner.id, label: owner.label } : null;

  /** La página pedida, o la que se está mirando. */
  const pageFor = async (key: string | undefined): Promise<CanvasPage> => {
    if (!key) return activePageOf(workspace);
    const page = findPage(useCanvasStore.getState().pages[workspace] ?? [], key);
    if (!page) throw new Error(`No hay ninguna página '${key}'. ${pagesLine(workspace)}`);
    return page;
  };

  switch (request.op) {
    case "read": {
      const page = await pageFor(str(request, "page"));
      return describe(workspace, page, owner);
    }

    case "pages": {
      const action = str(request, "action") ?? "list";
      const key = str(request, "page");
      if (action === "list") {
        await activePageOf(workspace);
        return pagesLine(workspace);
      }
      if (action === "create") {
        const id = newPageId();
        const count = useCanvasStore.getState().pages[workspace]?.length ?? 0;
        dispatchCanvas(workspace, [{ op: "page.create", id, name: str(request, "name") ?? defaultPageName(count + 1) }], actor);
        return `Created page ${id}. It is empty and not shown: use canvas_view page=${id} to show it. ${pagesLine(workspace)}`;
      }
      if (!key) throw new Error(`Falta 'page' para ${action}`);
      const page = await pageFor(key);
      if (action === "rename") {
        const name = str(request, "name");
        if (!name) throw new Error("Falta 'name'");
        dispatchCanvas(workspace, [{ op: "page.rename", page: page.id, name }], actor);
      } else if (action === "delete") {
        dispatchCanvas(workspace, [{ op: "page.remove", page: page.id }], actor);
      } else if (action === "activate") {
        setActivePage(workspace, page.id);
      } else if (action === "move") {
        dispatchCanvas(workspace, [{ op: "page.move", page: page.id, index: num(request, "index") ?? 0 }], actor);
      } else {
        throw new Error(`Acción desconocida '${action}': list, create, rename, delete, activate o move`);
      }
      return `Done. ${pagesLine(workspace)}`;
    }

    case "add": {
      const page = await pageFor(str(request, "page"));
      const kind = str(request, "kind");
      const title = str(request, "title");
      if (kind === "agent") {
        const tabId = str(request, "tab_id");
        if (!tabId) throw new Error("Falta 'tab_id': canvas_read lista los agentes del workspace");
        const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
        if (!tab || workspaceOf(tab.cwd) !== workspace) throw new Error(`No hay ninguna tab de agente ${tabId} en este workspace`);
        const id = addNode(workspace, page.id, { ...boxOf(request), kind: "agent", ref: tabId, title }, actor);
        return `Added agent "${tab.title}" to page "${page.name}" as node ${id}.`;
      }
      if (kind === "browser") {
        const id = addBrowser(cwd, page.id, str(request, "url") ?? "", { owner: owner ?? undefined, actor, box: { ...boxOf(request), title } });
        return `Added a browser to page "${page.name}" as node ${id}. It is your browser: browser_* tools drive it.`;
      }
      if (kind === "diagram" || kind === "doc") {
        const path = str(request, "path");
        if (!path) throw new Error(`Falta 'path': el archivo del ${kind === "doc" ? "documento" : "diagrama"}`);
        const { resolveInProject } = await import("@/features/diagram/paths");
        const id = addNode(workspace, page.id, { ...boxOf(request), kind, ref: resolveInProject(cwd, path), title }, actor);
        return `Added ${path} to page "${page.name}" as node ${id}.`;
      }
      if (kind === "note") {
        const id = addNode(workspace, page.id, { ...boxOf(request), kind: "note", text: str(request, "text") ?? "", title }, actor);
        return `Added a note to page "${page.name}" as node ${id}.`;
      }
      throw new Error("'kind' tiene que ser agent, browser, note, diagram o doc");
    }

    case "update": {
      const page = await pageFor(str(request, "page"));
      const changes = Array.isArray(request.changes) ? (request.changes as Record<string, unknown>[]) : [];
      if (changes.length === 0) throw new Error("Falta 'changes'");
      const ops: CanvasOp[] = changes.map((c) => {
        const change = c as CanvasRequest;
        const id = str(change, "id");
        if (!id) throw new Error("Cada cambio necesita su 'id'");
        if (change.remove === true) return { op: "node.remove", page: page.id, id };
        const to = str(change, "to_page");
        if (to) {
          const target = findPage(useCanvasStore.getState().pages[workspace] ?? [], to);
          if (!target) throw new Error(`No hay ninguna página '${to}'`);
          return { op: "node.toPage", page: page.id, id, to: target.id };
        }
        return {
          op: "node.update", page: page.id, id,
          patch: { x: num(change, "x"), y: num(change, "y"), w: num(change, "w"), h: num(change, "h"), title: str(change, "title"), text: str(change, "text") },
        };
      });
      const { touched } = dispatchCanvas(workspace, ops, actor);
      return `Applied ${ops.length} change(s) on page "${page.name}"${touched.length ? ` (${touched.join(", ")})` : ""}.`;
    }

    case "arrange": {
      const page = await pageFor(str(request, "page"));
      const layout = (str(request, "layout") ?? "grid") as ArrangeLayout;
      if (!["grid", "row", "column"].includes(layout)) throw new Error("'layout' tiene que ser grid, row o column");
      dispatchCanvas(workspace, [{ op: "page.arrange", page: page.id, layout }], actor);
      return `Arranged ${page.nodes.length} node(s) of page "${page.name}" as a ${layout}.`;
    }

    case "view": {
      const mode = str(request, "mode");
      const pageKey = str(request, "page");
      const page = await pageFor(pageKey);
      const focus = str(request, "focus");
      if (focus && !page.nodes.some((n) => n.id === focus)) throw new Error(`La página "${page.name}" no tiene ningún nodo ${focus}`);
      // Mostrar algo del canvas es mostrar el canvas.
      if (mode === "tabs") setCanvasMode(workspace, false);
      else if (mode === "canvas" || pageKey || focus || request.fit === true || num(request, "zoom")) setCanvasMode(workspace, true);
      if (pageKey) setActivePage(workspace, page.id);
      const zoom = num(request, "zoom");
      if (focus || request.fit === true || zoom) {
        // Después de que el canvas se monte con esa página.
        setTimeout(() => requestView({ workspace, page: page.id, focus, fit: request.fit === true, zoom }), 60);
      }
      return mode === "tabs" ? "The user now sees tabs." : `The user now sees page "${page.name}" of the canvas.`;
    }

    case "spawn": {
      const agent = str(request, "agent");
      if (!agent) throw new Error("Falta 'agent'");
      const page = await pageFor(str(request, "page"));
      const tabId = await deps.createTab(agent);
      const id = addNode(workspace, page.id, { ...boxOf(request), kind: "agent", ref: tabId }, actor);
      return `Launched ${agent} as tab ${tabId}, on page "${page.name}" as node ${id}.`;
    }

    default:
      if (request.op.startsWith("doc.") || request.op.startsWith("asset.")) {
        const { runDocRequest } = await import("@/features/docs/agentBridge");
        return runDocRequest(cwd, request, owner, actor);
      }
      if (request.op.startsWith("diagram.")) {
        // Diferido: los diagramas traen ELK y React Flow, y no hace falta cargarlos para el canvas.
        const { runDiagramRequest } = await import("@/features/diagram/agentBridge");
        return runDiagramRequest(cwd, request, actor);
      }
      throw new Error(`El canvas no sabe hacer '${request.op}'`);
  }
}

function pagesLine(workspace: string): string {
  const state = useCanvasStore.getState();
  const pages = state.pages[workspace] ?? [];
  const active = state.activePage[workspace];
  if (pages.length === 0) return "Pages: none yet.";
  return `Pages: ${pages.map((p) => `${p.name} (${p.id}, ${p.nodes.length} nodes${p.id === active ? ", shown" : ""})`).join("; ")}.`;
}

function describe(workspace: string, page: CanvasPage, owner: ViewOwner | null): string {
  const state = useCanvasStore.getState();
  const pages = state.pages[workspace] ?? [];
  const tabs = useTabsStore.getState().tabs;
  const views = useViewTabsStore.getState().views;
  const dormant = useDormant.getState().ids;
  const mode = state.canvasMode[workspace] ? "canvas" : "tabs";

  const agentState = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return "closed";
    return tab.ptyId != null ? "running" : dormant.has(tab.id) ? "not started (starts when shown)" : "starting";
  };
  const line = (n: CanvasNode) => {
    const box = `at (${n.x}, ${n.y}) ${n.w}×${n.h}`;
    const title = n.title ? ` "${n.title}"` : "";
    if (n.kind === "agent") {
      const tab = tabs.find((t) => t.id === n.ref);
      const you = owner?.kind === "tab" && owner.id === n.ref ? " (you)" : "";
      return `- ${n.id} agent${title} tab=${n.ref}${you} "${tab?.title ?? "?"}" ${tab?.agentId ?? ""} ${agentState(n.ref!)} ${box}`;
    }
    if (n.kind === "browser") {
      const view = views.find((v) => v.id === n.ref);
      const url = view?.kind === "browser" ? view.url || "(blank)" : "closed";
      const whose = view?.kind === "browser" && view.owner ? ` owned by ${view.owner.id === owner?.id ? "you" : view.owner.label}` : "";
      return `- ${n.id} browser${title} ${url}${whose} ${box}`;
    }
    if (n.kind === "diagram" || n.kind === "doc") {
      return `- ${n.id} ${n.kind}${title} ${n.ref ? relativeTo(n.ref, cwdOf(workspace)) : "?"} ${box}`;
    }
    const text = (n.text ?? "").replace(/\s+/g, " ").slice(0, 120);
    return `- ${n.id} note${title} "${text}" ${box}`;
  };

  const loose = agentsOf(workspace).filter((t) => !pageOfAgent(pages, t.id));
  const lines = [
    `Mode: ${mode}. ${pagesLine(workspace)}`,
    `Page "${page.name}" (${page.id})${page.id === state.activePage[workspace] ? ", the one shown" : ""}: ${page.nodes.length} node(s).`,
    ...page.nodes.map(line),
    `Viewport: x=${Math.round(page.viewport.x)} y=${Math.round(page.viewport.y)} zoom=${page.viewport.zoom.toFixed(2)}.`,
    loose.length
      ? `Agent tabs on no page: ${loose.map((t) => `tab=${t.id}${owner?.id === t.id ? " (you)" : ""} "${t.title}" ${agentState(t.id)}`).join("; ")}.`
      : "Every agent tab of the workspace is on some page.",
  ];
  return lines.join("\n");
}

/** La carpeta real del workspace (la de alguna de sus tabs), para mostrar rutas relativas. */
function cwdOf(workspace: string): string {
  return agentsOf(workspace)[0]?.cwd ?? workspace;
}
