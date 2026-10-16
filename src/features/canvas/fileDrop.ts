import { create } from "zustand";

import { centerOn } from "./actions";
import { DEFAULT_SIZE, type CanvasNodeKind } from "./model";
import { useCanvasLayer } from "./placements";
import { dispatchCanvas, newNodeId, useCanvasStore } from "./store";

export { canvasKindOf } from "./fileKinds";

/**
 * Soltar en el canvas un archivo que se arrastra desde el explorador: un diagrama, un
 * documento o una presentación vuelven a la página como un nodo, donde se soltaron. Es la
 * forma de traer de nuevo algo que se quitó del canvas (quitarlo no borra el archivo).
 */

/** El atributo con que se marca el canvas montado: ahí adentro se puede soltar. */
export const CANVAS_DROP_ATTR = "data-canvas-drop";

export interface CanvasDrop {
  workspace: string;
  pageId: string;
  /** Dónde cae, en coordenadas del canvas. */
  x: number;
  y: number;
}

/** Si en ese punto de la pantalla hay un canvas donde soltar, y dónde cae. */
export function canvasDropAt(clientX: number, clientY: number): CanvasDrop | null {
  const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(`[${CANVAS_DROP_ATTR}]`);
  const workspace = el?.getAttribute(CANVAS_DROP_ATTR);
  if (!el || !workspace) return null;
  const pageId = useCanvasStore.getState().activePage[workspace];
  if (!pageId) return null;
  const rect = el.getBoundingClientRect();
  const v = useCanvasLayer.getState().viewport;
  return { workspace, pageId, x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom };
}

/** Se está arrastrando algo que se puede soltar sobre este canvas: se marca para que se note. */
export const useCanvasDropHint = create<{ workspace: string | null }>(() => ({ workspace: null }));

export function setCanvasDropHint(workspace: string | null) {
  if (useCanvasDropHint.getState().workspace !== workspace) useCanvasDropHint.setState({ workspace });
}

/** Pone el archivo en la página, centrado donde se soltó. Si ya estaba en esa página, la
 *  vista va a ese nodo en vez de duplicarlo. */
export function dropFileOnCanvas(drop: CanvasDrop, file: { kind: CanvasNodeKind; ref: string }): string {
  const page = useCanvasStore.getState().pages[drop.workspace]?.find((p) => p.id === drop.pageId);
  const existing = page?.nodes.find((n) => n.kind === file.kind && n.ref === file.ref);
  if (existing) {
    centerOn(drop.workspace, drop.pageId, existing.id);
    return existing.id;
  }
  const size = DEFAULT_SIZE[file.kind];
  const id = newNodeId();
  dispatchCanvas(drop.workspace, [{
    op: "node.add",
    page: drop.pageId,
    id,
    spec: { kind: file.kind, ref: file.ref, x: drop.x - size.w / 2, y: drop.y - 15 },
  }]);
  return id;
}
