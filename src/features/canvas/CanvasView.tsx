import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow,
  type NodeChange, type Viewport as FlowViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import type { Placement } from "@/features/tabs/layout/layoutStore";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { activePageOf, focusNode, placementKey, workspaceOf } from "./actions";
import { CanvasNodeCard, type CanvasFlowNode } from "./CanvasNodeCard";
import { NODE_HEADER, type CanvasNode, type CanvasPage } from "./model";
import { setCanvasPlacements, setCanvasViewport } from "./placements";
import { dispatchCanvas, newNodeId, setCanvasFocus, useCanvasStore } from "./store";

/** Con menos zoom que esto las terminales y los navegadores no se dibujan: no se leería
 *  nada y seguirían gastando en pintar. El nodo muestra su nombre. */
export const LIVE_MIN_ZOOM = 0.35;
const MIN_ZOOM = 0.15;
/** Más de 100% agrandaría el texto de xterm como imagen: se vería borroso. */
const MAX_ZOOM = 1;

const NODE_TYPES = { card: CanvasNodeCard };

/**
 * El área de tabs como canvas: la página activa del workspace, con sus agentes, sus
 * navegadores y sus notas como nodos que se mueven.
 *
 * Solo la página activa está viva, y de ella solo lo que se ve: una terminal fuera de la
 * pantalla se oculta como una tab que no se mira (y termina hibernando), y una que todavía
 * no arrancó no se lanza hasta que su nodo aparece en pantalla (`useDormant`).
 */
export function CanvasView({ cwd }: { cwd: string }) {
  const workspace = workspaceOf(cwd);
  const loaded = useCanvasStore((s) => !!s.loaded[workspace]);
  const pages = useCanvasStore((s) => s.pages[workspace]);
  const activeId = useCanvasStore((s) => s.activePage[workspace]);
  const page = pages?.find((p) => p.id === activeId);

  // Desde el primer cuadro el área de tabs es del canvas, aunque la página esté cargando: si
  // no, las terminales se dibujarían un instante en su grupo de siempre, encima de todo.
  useLayoutEffect(() => {
    setCanvasPlacements(workspace, new Map());
    return () => setCanvasPlacements(null, new Map());
  }, [workspace]);

  useEffect(() => {
    activePageOf(workspace).catch(console.error);
  }, [workspace, loaded, activeId]);

  useWorkspaceSync(workspace);

  return (
    <div className="absolute inset-0 bg-gray-100 dark:bg-surface-deep">
      {page && (
        <ReactFlowProvider key={page.id}>
          <PageFlow workspace={workspace} page={page} pages={pages ?? []} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function toFlowNode(node: CanvasNode, workspace: string, pageId: string, pages: CanvasPage[], live: Set<string>, inert: boolean, selected?: boolean): CanvasFlowNode {
  return {
    id: node.id,
    type: "card",
    position: { x: node.x, y: node.y },
    width: node.w,
    height: node.h,
    dragHandle: ".cc-drag",
    selected,
    data: {
      node,
      workspace,
      pageId,
      live: live.has(node.id),
      inert,
      pages: pages.filter((p) => p.id !== pageId).map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

function PageFlow({ workspace, page, pages }: { workspace: string; page: CanvasPage; pages: CanvasPage[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewport = useRef<FlowViewport>(page.viewport);
  const [zoom, setZoom] = useState(page.viewport.zoom);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<Set<string>>(new Set());
  // Mientras se arrastra o se agranda un nodo, su caja vive acá; al soltarlo pasa al store.
  const [drafts, setDrafts] = useState<Record<string, { x?: number; y?: number; w?: number; h?: number }>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const tabIds = useTabsStore((s) => s.tabs.map((t) => t.id).join("|"));
  const viewIds = useViewTabsStore((s) => s.views.map((v) => v.id).join("|"));

  const inert = Math.abs(zoom - 1) > 0.01;
  const boxes = useMemo(
    () => page.nodes.map((n) => {
      const d = drafts[n.id];
      return d ? { ...n, ...d } : n;
    }),
    [page.nodes, drafts]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Qué se ve y dónde ──────────────────────────────────────────────
  const recompute = useCallback(() => {
    const v = viewport.current;
    const existing = new Set([...tabIds.split("|"), ...viewIds.split("|")].filter(Boolean));
    const visible = new Map<string, Placement>();
    const liveNow = new Set<string>();
    const margin = 200;
    const left = -v.x / v.zoom - margin;
    const top = -v.y / v.zoom - margin;
    const right = (size.width - v.x) / v.zoom + margin;
    const bottom = (size.height - v.y) / v.zoom + margin;
    const isInert = Math.abs(v.zoom - 1) > 0.01;
    for (const node of boxes) {
      const onScreen = node.x < right && node.x + node.w > left && node.y < bottom && node.y + node.h > top;
      if (!onScreen || v.zoom < LIVE_MIN_ZOOM || size.width === 0) continue;
      // Un diagrama se dibuja adentro de su nodo: solo hace falta saber que está a la vista.
      if (node.kind === "diagram") {
        liveNow.add(node.id);
        continue;
      }
      const key = placementKey(node);
      if (!key || !node.ref || !existing.has(node.ref)) continue;
      liveNow.add(node.id);
      visible.set(key, {
        groupId: "",
        rect: { left: node.x, top: node.y + NODE_HEADER, width: node.w, height: node.h - NODE_HEADER },
        inert: isInert,
        focus: () => focusNode(node),
      });
    }
    setCanvasPlacements(workspace, visible);
    setLive((prev) => (prev.size === liveNow.size && [...prev].every((id) => liveNow.has(id)) ? prev : liveNow));
  }, [boxes, size, tabIds, viewIds, workspace]);

  useEffect(() => {
    setCanvasViewport(viewport.current);
    recompute();
  }, [recompute]);

  const frame = useRef<number | null>(null);
  const onMove = useCallback((_: unknown, v: FlowViewport) => {
    viewport.current = v;
    // La capa de las terminales sigue al viewport en el mismo cuadro; lo que se ve se
    // recalcula a lo sumo una vez por cuadro.
    setCanvasViewport(v);
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setZoom(viewport.current.zoom);
        recompute();
      });
    }
  }, [recompute]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const onMoveEnd = useCallback((_: unknown, v: FlowViewport) => {
    dispatchCanvas(workspace, [{ op: "page.viewport", page: page.id, viewport: { x: v.x, y: v.y, zoom: v.zoom } }]);
  }, [workspace, page.id]);

  // ── Los nodos ─────────────────────────────────────────────────────
  const nodes = useMemo(
    () => boxes.map((n) => toFlowNode(n, workspace, page.id, pages, live, inert, selection.has(n.id))),
    [boxes, workspace, page.id, pages, live, inert, selection]
  );

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    const ops: Parameters<typeof dispatchCanvas>[1] = [];
    const nextDrafts = { ...drafts };
    let draftsChanged = false;
    let nextSelection: Set<string> | null = null;
    const resizingIds = new Set(changes.flatMap((c) => (c.type === "dimensions" && c.resizing ? [c.id] : [])));
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        // Agrandar desde la izquierda o desde arriba también mueve el nodo, sin `dragging`:
        // eso es parte del mismo gesto y se guarda al soltar.
        const resizing = resizingIds.has(change.id) || nextDrafts[change.id]?.w !== undefined;
        if (change.dragging || resizing) {
          nextDrafts[change.id] = { ...nextDrafts[change.id], x: change.position.x, y: change.position.y };
        } else {
          ops.push({ op: "node.update", page: page.id, id: change.id, patch: { x: change.position.x, y: change.position.y } });
          delete nextDrafts[change.id];
        }
        draftsChanged = true;
      } else if (change.type === "dimensions" && change.dimensions && typeof change.resizing === "boolean") {
        // Solo lo que manda el que agranda (`resizing`), no las mediciones de React Flow.
        const box = { ...nextDrafts[change.id], w: change.dimensions.width, h: change.dimensions.height };
        if (change.resizing) nextDrafts[change.id] = box;
        else {
          ops.push({ op: "node.update", page: page.id, id: change.id, patch: box });
          delete nextDrafts[change.id];
        }
        draftsChanged = true;
      } else if (change.type === "select") {
        nextSelection ??= new Set(selection);
        if (change.selected) nextSelection.add(change.id);
        else nextSelection.delete(change.id);
      } else if (change.type === "remove") {
        ops.push({ op: "node.remove", page: page.id, id: change.id });
      }
    }
    if (ops.length > 0) {
      try {
        dispatchCanvas(workspace, ops);
      } catch (e) {
        console.error(e);
      }
    }
    if (draftsChanged) setDrafts(nextDrafts);
    if (nextSelection) setSelection(nextSelection);
  }, [drafts, selection, page.id, workspace]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ReactFlow<CanvasFlowNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        defaultViewport={page.viewport}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onPaneClick={() => setCanvasFocus(null)}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        // Como un diseño: la rueda mueve, Ctrl+rueda (o pellizcar) acerca.
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        deleteKeyCode="Delete"
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        proOptions={{ hideAttribution: true }}
        className="cc-canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} className="!bg-transparent" color="var(--cc-canvas-dot)" />
        <ViewRequests workspace={workspace} page={page} />
      </ReactFlow>
    </div>
  );
}

/** Atiende los pedidos de mover la vista (centrar un nodo, ver todo) de esta página. */
function ViewRequests({ workspace, page }: { workspace: string; page: CanvasPage }) {
  const request = useCanvasStore((s) => s.viewRequest);
  const flow = useReactFlow();
  const handled = useRef<number | null>(null);

  useEffect(() => {
    if (!request || request.workspace !== workspace || request.page !== page.id || handled.current === request.nonce) return;
    handled.current = request.nonce;
    // Atendido: volver a esta página más tarde no tiene que repetirlo.
    useCanvasStore.setState({ viewRequest: null });
    const duration = 250;
    if (request.focus) {
      const node = page.nodes.find((n) => n.id === request.focus);
      if (node) {
        const zoom = request.zoom ?? 1;
        flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom, duration }).catch(console.error);
        // Al llegar a 100% su terminal ya recibe el puntero: se le da el teclado.
        setTimeout(() => focusNode(node), duration + 30);
      }
    } else if (request.fit) {
      flow.fitView({ padding: 0.12, duration, maxZoom: 1 }).catch(console.error);
    } else if (request.zoom) {
      flow.zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, request.zoom)), { duration }).catch(console.error);
    }
  }, [request, workspace, page, flow]);
  return null;
}

/**
 * Lo que el canvas sigue de las tabs de su workspace mientras está abierto:
 *
 * - un agente que se abre en esta ventana (el "+", el asistente, un agente que lanza otro)
 *   entra a la página que se está mirando: es donde se está trabajando;
 * - una tab que se cierra sale del canvas, igual que un navegador.
 */
function useWorkspaceSync(workspace: string) {
  useEffect(() => {
    let tabs = new Set(useTabsStore.getState().tabs.map((t) => t.id));
    let views = new Set(useViewTabsStore.getState().views.map((v) => v.id));

    const unsubTabs = useTabsStore.subscribe((state) => {
      if (!state.hydrated) return;
      const now = new Set(state.tabs.map((t) => t.id));
      const added = state.tabs.filter((t) => !tabs.has(t.id) && workspaceOf(t.cwd) === workspace);
      const gone = [...tabs].filter((id) => !now.has(id));
      tabs = now;
      const canvas = useCanvasStore.getState();
      const pageId = canvas.activePage[workspace];
      if (pageId && added.length > 0) {
        dispatchCanvas(workspace, added.map((t) => ({ op: "node.add" as const, page: pageId, id: newNodeId(), spec: { kind: "agent" as const, ref: t.id } })));
      }
      removeRefs(workspace, gone, "agent");
    });
    const unsubViews = useViewTabsStore.subscribe((state) => {
      const now = new Set(state.views.map((v) => v.id));
      const gone = [...views].filter((id) => !now.has(id));
      views = now;
      removeRefs(workspace, gone, "browser");
    });
    return () => {
      unsubTabs();
      unsubViews();
    };
  }, [workspace]);
}

function removeRefs(workspace: string, refs: string[], kind: "agent" | "browser") {
  if (refs.length === 0) return;
  const gone = new Set(refs);
  const pages = useCanvasStore.getState().pages[workspace] ?? [];
  const ops = pages.flatMap((p) =>
    p.nodes.filter((n) => n.kind === kind && n.ref && gone.has(n.ref)).map((n) => ({ op: "node.remove" as const, page: p.id, id: n.id }))
  );
  if (ops.length > 0) dispatchCanvas(workspace, ops);
}
