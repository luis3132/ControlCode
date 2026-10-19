import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, ConnectionMode, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type EdgeChange, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useTranslation } from "react-i18next";

import { FitIcon, RedoIcon, UndoIcon } from "@/app/icons";

import { ArrowEdge, DiagramContext, ShapeNode, type ArrowFlowEdge, type DiagramEditing, type ShapeFlowNode } from "./DiagramNodes";
import { EXPORT_FORMATS, exportDiagram, exportPath, type ExportFormat } from "./export";
import {
  COLORS, DEFAULT_NODE_SIZE, SHAPES, descendants, groupAt, parentsFirst, unrouted,
  type Arrow, type ColorName, type Diagram, type DiagramNode, type DiagramOp, type LineStyle, type Route, type Shape,
} from "./model";
import { PALETTE, PAPER, shapeOutline } from "./shapes";
import { markerDefs } from "./svg";
import { dispatchDiagram, layoutAndCommit, loadDiagram, redo, undo, useDiagramStore, watchDiagram } from "./store";

const NODE_TYPES = { shape: ShapeNode };
const EDGE_TYPES = { arrow: ArrowEdge };
const GRID = 10;

/** Lo copiado con Ctrl+C, para pegarlo en este u otro diagrama. */
let clipboard: { nodes: DiagramNode[]; edges: Diagram["edges"] } | null = null;

/**
 * Un diagrama editable: formas, flechas, grupos y texto, como un diagrams.net chico.
 *
 * `interactive: false` es como se ve en el canvas con zoom: se dibuja entero, sin
 * responder al puntero (React Flow mide mal el mouse dentro de algo escalado).
 */
export function DiagramEditor({ path, interactive = true }: { path: string; interactive?: boolean }) {
  const { t } = useTranslation();
  const doc = useDiagramStore((s) => s.docs[path]);

  useEffect(() => {
    loadDiagram(path).catch(() => {});
    return watchDiagram(path);
  }, [path]);

  if (doc?.error) {
    return <div className="flex items-center justify-center h-full p-6 text-center text-sm text-red-600">{doc.error}</div>;
  }
  if (!doc) {
    return <div className="flex items-center justify-center h-full text-xs text-gray-400">{t("diagram.loading")}</div>;
  }
  return (
    <ReactFlowProvider>
      <DiagramFlow path={path} diagram={doc.diagram} interactive={interactive} canUndo={doc.past.length > 0} canRedo={doc.future.length > 0} />
    </ReactFlowProvider>
  );
}

type Box = { x?: number; y?: number; w?: number; h?: number };

function DiagramFlow({ path, diagram, interactive, canUndo, canRedo }: {
  path: string; diagram: Diagram; interactive: boolean; canUndo: boolean; canRedo: boolean;
}) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, Box>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);

  const run = useCallback((ops: DiagramOp[]) => {
    if (ops.length === 0) return null;
    try {
      return dispatchDiagram(path, ops);
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [path]);

  const boxes = useMemo(() => diagram.nodes.map((n) => (drafts[n.id] ? { ...n, ...drafts[n.id] } : n)), [diagram.nodes, drafts]);
  const byId = useMemo(() => new Map(boxes.map((n) => [n.id, n])), [boxes]);

  const nodes: ShapeFlowNode[] = useMemo(() => parentsFirst(boxes).map((n) => ({
    id: n.id,
    type: "shape",
    position: { x: n.x, y: n.y },
    width: n.w,
    height: n.h,
    // Los grupos atrás: lo de adentro se tiene que poder agarrar.
    zIndex: n.shape === "group" ? 0 : 1,
    selected: selected.has(n.id),
    data: { node: n },
  })), [boxes, selected]);

  const edges: ArrowFlowEdge[] = useMemo(() => diagram.edges.flatMap((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return [];
    // Mientras se arrastra una de sus cajas, el recorrido que calculó ELK ya no la alcanza.
    const edge = drafts[e.from] || drafts[e.to] ? unrouted(e) : e;
    return [{ id: e.id, type: "arrow" as const, source: e.from, target: e.to, selected: selected.has(e.id), zIndex: 1, data: { edge, a, b } }];
  }), [diagram.edges, byId, selected, drafts]);

  // Fuera del editor (en el canvas con zoom) se ve siempre entero.
  useEffect(() => {
    if (!interactive) flow.fitView({ padding: 0.08 }).catch(() => {});
  }, [interactive, diagram, flow]);

  const onNodesChange = useCallback((changes: NodeChange<ShapeFlowNode>[]) => {
    const next = { ...drafts };
    let changed = false;
    const ended: string[] = [];
    let selection: Set<string> | null = null;
    const removed: DiagramOp[] = [];
    const moving = new Set(changes.flatMap((c) => (c.type === "position" ? [c.id] : [])));
    // Agrandar desde la izquierda o desde arriba también mueve el nodo, sin `dragging`: eso es
    // parte del mismo gesto y se guarda al soltar.
    const resizing = new Set(changes.flatMap((c) => (c.type === "dimensions" && c.resizing ? [c.id] : [])));
    const stillMoving = changes.some((c) => (c.type === "position" && c.dragging) || (c.type === "dimensions" && c.resizing));

    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const node = diagram.nodes.find((n) => n.id === change.id);
        if (!node) continue;
        const x = Math.round(change.position.x);
        const y = Math.round(change.position.y);
        next[change.id] = { ...next[change.id], x, y };
        // Un grupo arrastra lo suyo (salvo lo que ya se mueve por estar seleccionado).
        if (node.shape === "group") {
          for (const id of descendants(diagram, node.id)) {
            if (id === node.id || moving.has(id)) continue;
            const child = diagram.nodes.find((n) => n.id === id)!;
            next[id] = { ...next[id], x: child.x + x - node.x, y: child.y + y - node.y };
          }
        }
        changed = true;
        if (!change.dragging && !resizing.has(change.id) && next[change.id]?.w === undefined) ended.push(change.id);
      } else if (change.type === "dimensions" && change.dimensions && typeof change.resizing === "boolean") {
        next[change.id] = { ...next[change.id], w: Math.round(change.dimensions.width), h: Math.round(change.dimensions.height) };
        changed = true;
        if (!change.resizing) ended.push(change.id);
      } else if (change.type === "select") {
        selection ??= new Set(selected);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      } else if (change.type === "remove") {
        removed.push({ op: "node.remove", id: change.id });
      }
    }

    if (ended.length > 0) {
      // Los grupos primero: moverlos mueve lo de adentro, y después cada nodo queda donde se
      // soltó. Y al soltar algo adentro (o afuera) de un grupo, entra (o sale).
      const order = [...new Set(ended)].sort((a, b) => Number(diagram.nodes.find((n) => n.id === b)?.shape === "group") - Number(diagram.nodes.find((n) => n.id === a)?.shape === "group"));
      const ops: DiagramOp[] = [];
      for (const id of order) {
        const node = diagram.nodes.find((n) => n.id === id);
        const box = next[id];
        if (!node || !box) continue;
        const final = { ...node, ...box };
        const group = groupAt(diagram, final, descendants(diagram, id));
        const parent = group?.id ?? "";
        ops.push({ op: "node.update", id, patch: { x: final.x, y: final.y, w: final.w, h: final.h, ...(parent !== (node.parent ?? "") ? { parent } : {}) } });
      }
      run(ops);
      // Lo que se movía con un grupo también queda guardado: sin nada más en movimiento, no
      // queda ningún borrador.
      for (const id of stillMoving ? ended : Object.keys(next)) delete next[id];
      changed = true;
    }
    if (removed.length > 0) run(removed);
    if (changed) setDrafts(next);
    if (selection) setSelected(selection);
  }, [drafts, diagram, selected, run]);

  const onEdgesChange = useCallback((changes: EdgeChange<ArrowFlowEdge>[]) => {
    let selection: Set<string> | null = null;
    const removed: DiagramOp[] = [];
    for (const change of changes) {
      if (change.type === "select") {
        selection ??= new Set(selected);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      } else if (change.type === "remove") {
        removed.push({ op: "edge.remove", id: change.id });
      }
    }
    if (removed.length > 0) run(removed);
    if (selection) setSelected(selection);
  }, [selected, run]);

  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target) run([{ op: "edge.add", edge: { from: c.source, to: c.target } }]);
  }, [run]);

  const commitLabel = useCallback((id: string, kind: "node" | "edge", label: string) => {
    run([kind === "node" ? { op: "node.update", id, patch: { label } } : { op: "edge.update", id, patch: { label } }]);
  }, [run]);

  const editingCtx: DiagramEditing = useMemo(
    () => ({ path, interactive, editing, setEditing, commitLabel }),
    [path, interactive, editing, commitLabel]
  );

  /** Una forma nueva en el centro de lo que se ve (o donde se hizo doble click), para escribirle. */
  const addShape = useCallback((shape: Shape, at?: { x: number; y: number }) => {
    const size = DEFAULT_NODE_SIZE[shape];
    let center = at;
    if (!center) {
      const rect = wrapper.current?.getBoundingClientRect();
      center = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    }
    const x = Math.round((center.x - size.w / 2) / GRID) * GRID;
    const y = Math.round((center.y - size.h / 2) / GRID) * GRID;
    const parent = shape === "group" ? undefined : groupAt(diagram, { x, y, ...size }, new Set())?.id;
    const result = run([{ op: "node.add", node: { shape, x, y, ...(parent ? { parent } : {}) } }]);
    const id = result?.added[0];
    if (id) {
      setSelected(new Set([id]));
      if (shape !== "group") setEditing(id);
    }
  }, [diagram, flow, run]);

  const copy = useCallback(() => {
    const nodes = diagram.nodes.filter((n) => selected.has(n.id));
    if (nodes.length === 0) return;
    const ids = new Set(nodes.map((n) => n.id));
    clipboard = { nodes, edges: diagram.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [diagram, selected]);

  const paste = useCallback(() => {
    if (!clipboard) return;
    // Ids nuevos para todo, y las flechas y los grupos apuntando a las copias.
    const map = new Map<string, string>();
    const taken = new Set([...diagram.nodes.map((n) => n.id), ...diagram.edges.map((e) => e.id)]);
    const fresh = (prefix: string) => {
      for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) {
        taken.add(`${prefix}${i}`);
        return `${prefix}${i}`;
      }
    };
    for (const n of clipboard.nodes) map.set(n.id, fresh("n"));
    const ops: DiagramOp[] = parentsFirst(clipboard.nodes).map((n) => ({
      op: "node.add",
      node: { ...n, id: map.get(n.id)!, x: n.x + 30, y: n.y + 30, parent: n.parent && map.has(n.parent) ? map.get(n.parent) : undefined },
    }));
    for (const e of clipboard.edges) ops.push({ op: "edge.add", edge: { ...e, id: fresh("e"), from: map.get(e.from)!, to: map.get(e.to)! } });
    const result = run(ops);
    if (result) setSelected(new Set([...map.values()]));
  }, [diagram, run]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive || editing) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z" && !e.shiftKey) undo(path);
    else if (mod && (key === "y" || (key === "z" && e.shiftKey))) redo(path);
    else if (mod && key === "c") copy();
    else if (mod && key === "v") paste();
    else if (mod && key === "d") {
      copy();
      paste();
    } else if (key === "enter" && selected.size === 1) setEditing([...selected][0]!);
    else return;
    e.preventDefault();
  };

  return (
    <DiagramContext.Provider value={editingCtx}>
      <div
        ref={wrapper}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="nodrag nopan nowheel relative h-full w-full outline-none"
        style={{ background: PAPER }}
      >
        {/* Las puntas de flecha que usan las flechas (`url(#…)`). */}
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <defs dangerouslySetInnerHTML={{ __html: markerDefs(diagram.edges) }} />
        </svg>
        <ReactFlow<ShapeFlowNode, ArrowFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          connectionMode={ConnectionMode.Loose}
          onNodeDoubleClick={(_, node) => interactive && setEditing(node.id)}
          onEdgeDoubleClick={(_, edge) => interactive && setEditing(edge.id)}
          onDoubleClick={(e) => {
            if (!interactive || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
            addShape("rounded", flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={3}
          snapToGrid
          snapGrid={[GRID, GRID]}
          elevateNodesOnSelect={false}
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          elementsSelectable={interactive}
          panOnDrag={interactive}
          panOnScroll={interactive}
          zoomOnScroll={false}
          zoomOnPinch={interactive}
          zoomOnDoubleClick={false}
          deleteKeyCode={interactive && !editing ? ["Delete", "Backspace"] : null}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control"]}
          proOptions={{ hideAttribution: true }}
          className="cc-diagram"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />
        </ReactFlow>
        {interactive && (
          <Toolbar
            path={path}
            diagram={diagram}
            selected={selected}
            canUndo={canUndo}
            canRedo={canRedo}
            onAdd={(shape) => addShape(shape)}
            onFit={() => flow.fitView({ padding: 0.15, duration: 200, maxZoom: 1.2 }).catch(() => {})}
            run={run}
          />
        )}
      </div>
    </DiagramContext.Provider>
  );
}

const BAR = "absolute flex items-center gap-0.5 p-0.5 rounded-lg shadow-sm ring-1 ring-black/8 bg-white/95 backdrop-blur text-gray-600";
const BTN = "flex items-center justify-center gap-1 h-7 min-w-7 px-1.5 rounded-md text-xs hover:bg-gray-100 hover:text-gray-900 disabled:opacity-35 disabled:hover:bg-transparent";

function ShapeIcon({ shape }: { shape: Shape }) {
  const { d, extra } = shapeOutline(shape === "text" ? "rect" : shape, 22, shape === "actor" ? 18 : 15);
  return (
    <svg width={24} height={20} viewBox="-1 -2 24 20" aria-hidden>
      <path d={d} fill={shape === "text" ? "none" : "#fff"} stroke="currentColor" strokeWidth={1.3} strokeDasharray={shape === "group" || shape === "text" ? "3 2" : undefined} />
      {extra && <path d={extra} fill="none" stroke="currentColor" strokeWidth={1.3} />}
    </svg>
  );
}

/** Arriba: las formas para agregar, deshacer, acomodar y exportar. Abajo, con algo
 *  seleccionado: su forma, su color y, en una flecha, sus puntas y su trazo. */
function Toolbar({ path, diagram, selected, canUndo, canRedo, onAdd, onFit, run }: {
  path: string; diagram: Diagram; selected: Set<string>; canUndo: boolean; canRedo: boolean;
  onAdd: (shape: Shape) => void; onFit: () => void; run: (ops: DiagramOp[]) => unknown;
}) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const selNodes = diagram.nodes.filter((n) => selected.has(n.id));
  const selEdges = diagram.edges.filter((e) => selected.has(e.id));

  const doExport = async (format: ExportFormat) => {
    setMenu(false);
    setExporting(true);
    try {
      const out = await exportDiagram(diagram, format, exportPath(path, format));
      setStatus(t("diagram.exported", { file: out.split(/[\\/]/).pop() }));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
      setTimeout(() => setStatus(null), 5000);
    }
  };

  const setColor = (color: ColorName) => run([
    ...selNodes.map((n) => ({ op: "node.update" as const, id: n.id, patch: { color } })),
    ...selEdges.map((e) => ({ op: "edge.update" as const, id: e.id, patch: { color } })),
  ]);

  return (
    <>
      <div className={`${BAR} top-2 left-2 right-2 w-fit max-w-[calc(100%-1rem)] overflow-x-auto cc-scroll-x`}>
        {SHAPES.map((shape) => (
          <button key={shape} className={BTN} title={t(`diagram.shape.${shape}`)} onClick={() => onAdd(shape)}>
            <ShapeIcon shape={shape} />
          </button>
        ))}
        <span className="w-px h-5 mx-1 bg-gray-200" />
        <button className={BTN} title={t("diagram.undo")} disabled={!canUndo} onClick={() => undo(path)}><UndoIcon className="w-3.5 h-3.5" /></button>
        <button className={BTN} title={t("diagram.redo")} disabled={!canRedo} onClick={() => redo(path)}><RedoIcon className="w-3.5 h-3.5" /></button>
        <span className="w-px h-5 mx-1 bg-gray-200" />
        <button className={BTN} title={t("diagram.layout.lr")} disabled={diagram.nodes.length < 2} onClick={() => layoutAndCommit(path, "LR").then(onFit).catch(console.error)}>
          {t("diagram.layout.lrShort")}
        </button>
        <button className={BTN} title={t("diagram.layout.tb")} disabled={diagram.nodes.length < 2} onClick={() => layoutAndCommit(path, "TB").then(onFit).catch(console.error)}>
          {t("diagram.layout.tbShort")}
        </button>
        <button className={BTN} title={t("diagram.fit")} onClick={onFit}><FitIcon className="w-3.5 h-3.5" /></button>
        <span className="w-px h-5 mx-1 bg-gray-200" />
        <div className="relative">
          <button className={BTN} disabled={exporting || diagram.nodes.length === 0} onClick={() => setMenu((m) => !m)}>
            {exporting ? t("diagram.exporting") : t("diagram.export")}
          </button>
          {menu && (
            <div className="fixed z-50 mt-1 py-1 w-40 rounded-md shadow-lg bg-white ring-1 ring-black/10">
              {EXPORT_FORMATS.map((f) => (
                <button key={f} onClick={() => doExport(f)} className="block w-full text-left px-3 py-1 text-xs text-gray-700 hover:bg-gray-100">
                  {t(`diagram.format.${f}`)}
                </button>
              ))}
            </div>
          )}
        </div>
        {status && <span className="px-2 text-[11px] text-gray-500 whitespace-nowrap">{status}</span>}
      </div>

      {(selNodes.length > 0 || selEdges.length > 0) && (
        <div className={`${BAR} bottom-2 left-1/2 -translate-x-1/2`}>
          {COLORS.map((c) => (
            <button key={c} className={BTN} title={t(`diagram.color.${c}`)} onClick={() => setColor(c)}>
              <span className="w-4 h-4 rounded-full border" style={{ background: PALETTE[c].fill, borderColor: PALETTE[c].stroke }} />
            </button>
          ))}
          {selNodes.length > 0 && (
            <>
              <span className="w-px h-5 mx-1 bg-gray-200" />
              <select
                className="h-7 px-1 rounded-md text-xs bg-transparent hover:bg-gray-100 outline-none"
                value={selNodes.every((n) => n.shape === selNodes[0]!.shape) ? selNodes[0]!.shape : ""}
                onChange={(e) => run(selNodes.map((n) => ({ op: "node.update" as const, id: n.id, patch: { shape: e.target.value as Shape } })))}
              >
                {SHAPES.filter((s) => s !== "group").map((s) => <option key={s} value={s}>{t(`diagram.shape.${s}`)}</option>)}
                {selNodes.some((n) => n.shape === "group") && <option value="group">{t("diagram.shape.group")}</option>}
              </select>
            </>
          )}
          {selEdges.length > 0 && (
            <>
              <span className="w-px h-5 mx-1 bg-gray-200" />
              <EdgeChoice label={t("diagram.edge.arrow")} value={selEdges[0]!.arrow ?? "end"} options={["end", "start", "both", "none"] as Arrow[]}
                onChange={(arrow) => run(selEdges.map((e) => ({ op: "edge.update" as const, id: e.id, patch: { arrow } })))} />
              <EdgeChoice label={t("diagram.edge.style")} value={selEdges[0]!.style ?? "solid"} options={["solid", "dashed"] as LineStyle[]}
                onChange={(style) => run(selEdges.map((e) => ({ op: "edge.update" as const, id: e.id, patch: { style } })))} />
              <EdgeChoice label={t("diagram.edge.route")} value={selEdges[0]!.route ?? "orthogonal"} options={["orthogonal", "straight", "curved"] as Route[]}
                onChange={(route) => run(selEdges.map((e) => ({ op: "edge.update" as const, id: e.id, patch: { route } })))} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function EdgeChoice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (v: T) => void }) {
  const { t } = useTranslation();
  return (
    <select
      aria-label={label}
      title={label}
      className="h-7 px-1 rounded-md text-xs bg-transparent hover:bg-gray-100 outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => <option key={o} value={o}>{t(`diagram.edge.${o}`)}</option>)}
    </select>
  );
}
