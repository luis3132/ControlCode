/**
 * Qué ventanas de un canvas está cambiando un agente sin que se vean: un documento, un
 * diagrama, una presentación o una nota que un agente edita en otra página del canvas, en
 * otro workspace, o con el canvas oculto.
 *
 * Es lo único que muestra la esquina (`BackgroundAgents`). Antes listaba todo agente
 * ocupado fuera de la vista —cualquier tab escribiendo, cualquier tarea de la flota— y eso
 * era ruido permanente: que un agente trabaje es lo normal. Lo que sí merece un aviso es
 * que algo que forma parte de tu canvas está cambiando y no lo estás viendo.
 *
 * Sale de la presencia del canvas (`useCanvasStore.presence`), que ya se marca con cada
 * cambio de un agente y se borra sola unos segundos después: el aviso dura lo que dura la
 * edición. Puro: recibe todo lo que necesita y se prueba en Node.
 */
import type { CanvasNode, CanvasNodeKind, CanvasPage } from "@/features/canvas/model";
import type { Presence } from "@/features/canvas/store";

export interface CanvasEdit {
  /** `workspace:nodo`: una entrada por ventana. */
  key: string;
  workspace: string;
  pageId: string;
  pageName: string;
  nodeId: string;
  kind: CanvasNodeKind;
  /** El nombre propio del nodo, o el del archivo que muestra. `null` = se nombra por su tipo. */
  name: string | null;
  /** Quién la está cambiando: una tab de agente o una tarea de la flota. */
  actor: { id: string; label: string };
  at: number;
}

export interface CanvasEditsInput {
  pages: Record<string, CanvasPage[]>;
  canvasMode: Record<string, boolean>;
  activePage: Record<string, string>;
  presence: Record<string, Presence>;
  /** El workspace cuyo canvas está a la vista ahora, o `null` si no se ve ninguno (otra
   *  pantalla, la ventana oculta). */
  shownWorkspace: string | null;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** La presencia más reciente sobre un nodo: la del nodo mismo y la de lo que muestra. */
function presenceOf(node: CanvasNode, presence: Record<string, Presence>): Presence | null {
  let best: Presence | null = presence[node.id] ?? null;
  const consider = (p: Presence | undefined) => {
    if (p && (!best || p.at > best.at)) best = p;
  };
  if (node.ref) {
    if (node.kind === "doc") consider(presence[`${node.ref}#doc`]);
    if (node.kind === "slides") consider(presence[`${node.ref}#slides`]);
    if (node.kind === "diagram") {
      // Un diagrama se marca por figura (`<ruta>#<id>`).
      const prefix = `${node.ref}#`;
      for (const [key, p] of Object.entries(presence)) if (key.startsWith(prefix)) consider(p);
    }
  }
  return best;
}

export function canvasEdits(input: CanvasEditsInput): CanvasEdit[] {
  const out: CanvasEdit[] = [];
  for (const [workspace, pages] of Object.entries(input.pages)) {
    if (!input.canvasMode[workspace]) continue;
    const active = input.activePage[workspace] ?? pages[0]?.id;
    for (const page of pages) {
      const inView = workspace === input.shownWorkspace && page.id === active;
      if (inView) continue;
      for (const node of page.nodes) {
        // La terminal de un agente es el agente trabajando, no algo que esté cambiando.
        if (node.kind === "agent") continue;
        const p = presenceOf(node, input.presence);
        if (!p) continue;
        out.push({
          key: `${workspace}:${node.id}`,
          workspace,
          pageId: page.id,
          pageName: page.name,
          nodeId: node.id,
          kind: node.kind,
          name: node.title ?? (node.ref && node.kind !== "browser" ? basename(node.ref) : null),
          actor: { id: p.id, label: p.label },
          at: p.at,
        });
      }
    }
  }
  // Lo último que cambió, primero.
  return out.sort((a, b) => b.at - a.at);
}
