import { createContext, memo, useContext, useEffect, useRef } from "react";
import {
  BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";

import { agentPaint } from "@/features/browser/agentPaint";
import { PRESENCE_MS, useCanvasStore } from "@/features/canvas/store";

import { MIN_NODE, type DiagramEdge, type DiagramNode } from "./model";
import {
  FONT, FONT_SIZE, LINE_HEIGHT, PAPER, arrowAtEnd, arrowAtStart, edgeColor, edgeGeometry, groupSwatch, labelBox,
  labelLines, shapeOutline, swatch,
} from "./shapes";
import { presenceKey } from "./store";

/** Lo que los nodos y las flechas necesitan del editor, sin pasarlo por cada `data`. */
export interface DiagramEditing {
  path: string;
  interactive: boolean;
  /** El nodo o la flecha cuyo texto se está escribiendo. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  commitLabel: (id: string, kind: "node" | "edge", label: string) => void;
}

export const DiagramContext = createContext<DiagramEditing | null>(null);

const useEditing = () => {
  const ctx = useContext(DiagramContext);
  if (!ctx) throw new Error("Fuera de un editor de diagramas");
  return ctx;
};

/** El color de quien tocó esto hace un momento, si fue un agente. */
function usePresenceColor(path: string, id: string): { color: string; label: string } | null {
  const presence = useCanvasStore((s) => s.presence[presenceKey(path, id)]);
  if (!presence || Date.now() - presence.at >= PRESENCE_MS) return null;
  return { color: agentPaint(presence.id).hex, label: presence.label };
}

export type ShapeFlowNode = Node<{ node: DiagramNode }, "shape">;
export type ArrowFlowEdge = Edge<{ edge: DiagramEdge; a: DiagramNode; b: DiagramNode }, "arrow">;

const HANDLE = "!w-2 !h-2 !min-w-0 !min-h-0 !border !border-white !bg-accent-500 opacity-0 group-hover:opacity-100 transition-opacity";

/**
 * Una forma: el mismo SVG que sale al exportar (ver `shapes.ts`), con sus cuatro puntos
 * para unirla con flechas y su texto editable con doble click.
 */
export const ShapeNode = memo(function ShapeNode({ data, selected }: NodeProps<ShapeFlowNode>) {
  const { node } = data;
  const { path, interactive, editing } = useEditing();
  const presence = usePresenceColor(path, node.id);
  const { d, extra } = shapeOutline(node.shape, node.w, node.h);
  const colors = node.shape === "group" ? groupSwatch(node.color) : swatch(node.color);
  const label = labelLines(node);
  const isEditing = editing === node.id;

  return (
    <div className="group relative" style={{ width: node.w, height: node.h }}>
      {interactive && (
        <NodeResizer
          isVisible={selected && !isEditing}
          minWidth={MIN_NODE.w}
          minHeight={MIN_NODE.h}
          lineClassName="!border-accent-500/70"
          handleClassName="!w-2 !h-2 !rounded-sm !bg-white !border !border-accent-500"
        />
      )}
      <svg width={node.w} height={node.h} overflow="visible" style={{ fontFamily: FONT, display: "block" }}>
        {node.shape !== "text" && (
          <path
            d={d}
            fill={colors.fill}
            stroke={colors.stroke}
            strokeWidth={1.5}
            strokeDasharray={node.shape === "group" ? "6 4" : undefined}
          />
        )}
        {extra && <path d={extra} fill="none" stroke={colors.stroke} strokeWidth={1.5} />}
        {(selected || presence) && (
          <rect
            x={-4} y={-4} width={node.w + 8} height={node.h + 8} rx={6} fill="none"
            stroke={presence?.color ?? "var(--color-accent-500)"}
            strokeWidth={presence ? 2.5 : 1.25}
            strokeDasharray={presence ? undefined : "4 3"}
          />
        )}
        {!isEditing && (
          <text fill={colors.text} textAnchor={label.anchor} fontSize={FONT_SIZE} fontWeight={node.shape === "group" ? 600 : undefined}>
            {label.lines.map((line, i) => (
              <tspan key={i} x={label.x} y={label.y + i * LINE_HEIGHT}>{line}</tspan>
            ))}
          </text>
        )}
      </svg>
      {presence && (
        <span className="absolute -top-5 left-0 px-1.5 rounded text-[10px] font-medium text-white whitespace-nowrap" style={{ background: presence.color }}>
          {presence.label}
        </span>
      )}
      {isEditing && <LabelInput id={node.id} kind="node" initial={node.label} box={labelBox(node)} />}
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={{ top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }[side]}
          isConnectable={interactive}
          className={HANDLE}
        />
      ))}
    </div>
  );
});

/** Una flecha: la geometría la calcula `edgeGeometry`, igual que al exportar. */
export const ArrowEdge = memo(function ArrowEdge({ id, data, selected }: EdgeProps<ArrowFlowEdge>) {
  const { path, editing, setEditing, interactive } = useEditing();
  const presence = usePresenceColor(path, id);
  if (!data) return null;
  const { edge, a, b } = data;
  const geo = edgeGeometry(a, b, edge.route, edge);
  const color = edgeColor(edge);
  const marker = (start: boolean) => `url(#a${start ? "s" : "e"}${color.replace("#", "")})`;
  const isEditing = editing === id;

  return (
    <>
      <BaseEdge
        id={id}
        path={geo.path}
        markerEnd={arrowAtEnd(edge.arrow) ? marker(false) : undefined}
        markerStart={arrowAtStart(edge.arrow) ? marker(true) : undefined}
        interactionWidth={16}
        style={{
          stroke: presence?.color ?? (selected ? "var(--color-accent-500)" : color),
          strokeWidth: selected || presence ? 2.5 : 1.5,
          strokeDasharray: edge.style === "dashed" ? "6 5" : undefined,
        }}
      />
      {(edge.label || isEditing) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{ transform: `translate(-50%, -50%) translate(${geo.label.x}px, ${geo.label.y}px)`, pointerEvents: "all" }}
            onDoubleClick={() => interactive && setEditing(id)}
          >
            {isEditing ? (
              <LabelInput id={id} kind="edge" initial={edge.label ?? ""} />
            ) : (
              <div
                className="px-1.5 rounded whitespace-pre text-center"
                style={{ background: PAPER, color: "#334155", fontFamily: FONT, fontSize: FONT_SIZE - 1, lineHeight: `${LINE_HEIGHT}px` }}
              >
                {edge.label}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** Escribir el texto de un nodo o una flecha ahí mismo. Enter guarda, Shift+Enter baja de
 *  línea, Escape descarta. */
function LabelInput({ id, kind, initial, box }: {
  id: string; kind: "node" | "edge"; initial: string; box?: { x: number; y: number; w: number; h: number };
}) {
  const { setEditing, commitLabel } = useEditing();
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) commitLabel(id, kind, ref.current?.value ?? initial);
    setEditing(null);
  };

  return (
    <textarea
      ref={ref}
      defaultValue={initial}
      rows={Math.max(1, initial.split("\n").length)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
        if (e.key === "Escape") finish(false);
      }}
      className="nodrag nopan nowheel resize-none outline-none rounded text-center bg-white/95 ring-2 ring-accent-500/70"
      style={{
        fontFamily: FONT,
        fontSize: FONT_SIZE,
        lineHeight: `${LINE_HEIGHT}px`,
        color: "#0f172a",
        ...(box
          ? { position: "absolute", left: box.x, top: box.y, width: Math.max(80, box.w), height: Math.max(LINE_HEIGHT + 6, box.h) }
          : { minWidth: 120 }),
      }}
    />
  );
}
