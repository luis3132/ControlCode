import i18n from "@/i18n";
import { activateItem } from "@/features/tabs/layout/layoutStore";
import { agentKey, viewKey } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type ViewOwner } from "@/features/tabs/viewTabs";

import type { CanvasNode, NodeSpec } from "./model";
import {
  dispatchCanvas, ensureActivePage, ensureLoaded, newNodeId, requestView, setCanvasFocus, setCanvasMode,
  useCanvasStore, type CanvasActor,
} from "./store";

/**
 * Lo que se hace sobre el canvas desde la interfaz o desde un agente. Los dos caminos
 * llaman a estas mismas funciones, que terminan en `dispatchCanvas`.
 */

export const workspaceOf = (cwd: string) => comparablePath(cwd);

export function defaultPageName(n: number): string {
  return i18n.t("canvas.page.default", { n });
}

/** La página que se está mirando, cargando el canvas y creando una vacía si hace falta. */
export async function activePageOf(workspace: string) {
  await ensureLoaded(workspace);
  const count = useCanvasStore.getState().pages[workspace]?.length ?? 0;
  return ensureActivePage(workspace, defaultPageName(count + 1));
}

/** La clave de placements de lo que muestra un nodo (`a:<tab>`, `v:<vista>`). */
export function placementKey(node: CanvasNode): string | null {
  if (node.kind === "agent" && node.ref) return agentKey(node.ref);
  if (node.kind === "browser" && node.ref) return viewKey(node.ref);
  return null;
}

/** Darle el teclado a la terminal o el navegador de un nodo. */
export function focusNode(node: CanvasNode) {
  const key = placementKey(node);
  if (!key) return;
  setCanvasFocus(key);
  // Que el resto de la app (barra de estado, explorador, atajos) sepa qué se está mirando.
  activateItem(key);
}

export function addNode(workspace: string, pageId: string, spec: NodeSpec, actor: CanvasActor | null = null): string {
  const id = newNodeId();
  const { added } = dispatchCanvas(workspace, [{ op: "node.add", page: pageId, id, spec }], actor);
  return added[0] ?? id;
}

/** Abre un navegador del workspace (una tab de navegador, como la del botón de la barra) y
 *  lo pone en la página. Si lo pide un agente, el navegador es suyo. */
export function addBrowser(cwd: string, pageId: string, url: string, opts: { owner?: ViewOwner; actor?: CanvasActor | null; box?: Partial<NodeSpec> } = {}): string {
  const viewId = useViewTabsStore.getState().openBrowser(cwd, url, { activate: false, owner: opts.owner });
  return addNode(workspaceOf(cwd), pageId, { ...opts.box, kind: "browser", ref: viewId }, opts.actor ?? null);
}

export function toggleCanvas(cwd: string) {
  const workspace = workspaceOf(cwd);
  setCanvasMode(workspace, !useCanvasStore.getState().canvasMode[workspace]);
}

export function centerOn(workspace: string, pageId: string, nodeId: string) {
  requestView({ workspace, page: pageId, focus: nodeId });
}

/** Las tabs de agente de esta ventana que son de ese workspace. */
export function agentsOf(workspace: string) {
  return useTabsStore.getState().tabs.filter((t) => workspaceOf(t.cwd) === workspace);
}

/** Un navegador nuevo en la página que se está mirando, centrado en la vista. */
export async function addBrowserHere(cwd: string) {
  const workspace = workspaceOf(cwd);
  const page = await activePageOf(workspace);
  centerOn(workspace, page.id, addBrowser(cwd, page.id, ""));
}
