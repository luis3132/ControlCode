import { create } from "zustand";

import type { Placement } from "@/features/tabs/layout/layoutStore";

/**
 * Dónde dibujar las terminales y los navegadores cuando el área de tabs es un canvas.
 *
 * Es el mismo truco que usa la pantalla dividida (ver `EditorArea`): nada que tenga un
 * proceso o una página se muda de padre en React. `TerminalPanel` y `ViewTabsHost` siguen
 * dibujando todo en su lugar de siempre, y el canvas solo les dice dónde va cada uno. Las
 * cajas van en coordenadas del canvas; la capa que los contiene lleva la misma traslación y
 * escala que el viewport, así que mover la vista no le cambia el tamaño a ninguna terminal
 * (su TUI no recibe un resize por cada paso del zoom) ni re-renderiza nada.
 */
interface CanvasLayer {
  /** El workspace que se está mostrando como canvas. `null` = modo tabs. */
  workspace: string | null;
  /** Lo que se ve de la página activa, en coordenadas del canvas. */
  visible: Map<string, Placement>;
  /** La traslación y escala de la capa: el viewport del canvas. */
  viewport: { x: number; y: number; zoom: number };
}

export const useCanvasLayer = create<CanvasLayer>(() => ({
  workspace: null,
  visible: new Map(),
  viewport: { x: 0, y: 0, zoom: 1 },
}));

function samePlacements(a: Map<string, Placement>, b: Map<string, Placement>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, p] of a) {
    const q = b.get(key);
    if (!q || q.inert !== p.inert) return false;
    const r = p.rect;
    const s = q.rect;
    if (r === null || s === null ? r !== s : r.left !== s.left || r.top !== s.top || r.width !== s.width || r.height !== s.height) {
      return false;
    }
  }
  return true;
}

export function setCanvasPlacements(workspace: string | null, visible: Map<string, Placement>) {
  const state = useCanvasLayer.getState();
  if (state.workspace === workspace && samePlacements(state.visible, visible)) return;
  useCanvasLayer.setState({ workspace, visible });
}

export function setCanvasViewport(viewport: { x: number; y: number; zoom: number }) {
  const v = useCanvasLayer.getState().viewport;
  if (v.x === viewport.x && v.y === viewport.y && v.zoom === viewport.zoom) return;
  useCanvasLayer.setState({ viewport });
}
