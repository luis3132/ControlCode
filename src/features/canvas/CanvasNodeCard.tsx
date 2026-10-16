import { Suspense, lazy, memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "neogestify-ui-components";

import { DiagramIcon, DocIcon, ExternalIcon, GlobeIcon, NoteIcon, SlidesIcon, ZoomInIcon } from "@/app/icons";
import { slidesPresenceKey } from "@/features/slides/store";
import { docPresenceKey } from "@/features/docs/store";
import { useDiagramStore } from "@/features/diagram/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { agentPaint } from "@/features/browser/agentPaint";
import { useDormant, useHibernation } from "@/features/terminal/hibernation";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { agentsOf, centerOn, focusNode, placementKey } from "./actions";
import { MIN_SIZE, NODE_HEADER, type CanvasNode } from "./model";
import { PRESENCE_MS, dispatchCanvas, setCanvasMode, useCanvasStore } from "./store";

export interface CanvasNodeData extends Record<string, unknown> {
  node: CanvasNode;
  workspace: string;
  pageId: string;
  /** Se ve su terminal o su navegador (en pantalla y con zoom suficiente). */
  live: boolean;
  /** Con zoom distinto de 100%: se ve, pero el puntero va al nodo y no a la terminal. */
  inert: boolean;
  /** Las otras páginas, para "mover a". */
  pages: { id: string; name: string }[];
}

export type CanvasFlowNode = Node<CanvasNodeData, "card">;

// React Flow y ELK solo se bajan cuando hay un diagrama a la vista; el Markdown, cuando hay
// un documento.
const DiagramEditor = lazy(() => import("@/features/diagram/DiagramEditor").then((m) => ({ default: m.DiagramEditor })));
const DocView = lazy(() => import("@/features/docs/DocView").then((m) => ({ default: m.DocView })));
const SlidesView = lazy(() => import("@/features/slides/SlidesView").then((m) => ({ default: m.SlidesView })));

/**
 * Un nodo del canvas: una cabecera por donde se agarra y, abajo, su contenido.
 *
 * El contenido de un agente o un navegador NO se dibuja acá: es un hueco sobre el que
 * `TerminalPanel` o `ViewTabsHost` ponen la terminal o la página (ver `placements.ts`).
 * Lo que sí se dibuja es lo que se ve cuando no están: lejos, con poco zoom, o un agente
 * que todavía no arrancó.
 */
export const CanvasNodeCard = memo(function CanvasNodeCard({ data, selected }: NodeProps<CanvasFlowNode>) {
  const { t } = useTranslation();
  const { node, workspace, pageId, live, inert, pages } = data;
  const tab = useTabsStore((s) => (node.kind === "agent" ? s.tabs.find((x) => x.id === node.ref) : undefined));
  const view = useViewTabsStore((s) => {
    const found = node.kind === "browser" ? s.views.find((v) => v.id === node.ref) : undefined;
    return found?.kind === "browser" ? found : undefined;
  });
  const dormant = useDormant((s) => (node.ref ? s.ids.has(node.ref) : false));
  const hibernated = useHibernation((s) => (node.ref ? s.ids.has(node.ref) : false));
  // Lo que un agente escribió en el documento con `doc_write` también pinta el nodo.
  const presence = useCanvasStore((s) => s.presence[node.id]
    ?? (node.kind === "doc" && node.ref ? s.presence[docPresenceKey(node.ref)]
      : node.kind === "slides" && node.ref ? s.presence[slidesPresenceKey(node.ref)] : undefined));
  const focused = useCanvasStore((s) => s.focusedItem !== null && s.focusedItem === placementKey(node));
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState(false);
  const diagramTitle = useDiagramStore((s) => (node.kind === "diagram" && node.ref ? s.docs[node.ref]?.diagram.title : undefined));

  // De quién es: el color del agente (o del que maneja el navegador). Quien acaba de tocar
  // el nodo lo pinta encima con el suyo mientras dure.
  const ownerId = node.kind === "agent" ? node.ref : view?.owner?.id;
  const own = ownerId ? agentPaint(ownerId).hex : null;
  const touching = presence && Date.now() - presence.at < PRESENCE_MS ? presence : null;
  const ring = touching ? agentPaint(touching.id).hex : null;

  const missing = (node.kind === "agent" && !tab) || (node.kind === "browser" && !view);
  const title = node.title
    ?? (node.kind === "agent" ? tab?.title
      : node.kind === "browser" ? view?.title || view?.url || t("browser.newTab")
      : node.kind === "diagram" ? diagramTitle ?? node.ref?.split(/[\\/]/).pop()
      : node.kind === "doc" || node.kind === "slides" ? node.ref?.split(/[\\/]/).pop()
      : t("canvas.note"))
    ?? t("canvas.node.closed");
  const Icon = node.kind === "agent" ? agentIcon(tab?.agentId ?? "bash", tab?.command ?? "")
    : node.kind === "browser" ? GlobeIcon : node.kind === "diagram" ? DiagramIcon : node.kind === "doc" ? DocIcon : node.kind === "slides" ? SlidesIcon : NoteIcon;
  const state = node.kind !== "agent" || !tab ? null
    : tab.ptyId != null ? (hibernated ? t("canvas.agent.sleeping") : t("canvas.agent.running"))
    : dormant ? t("canvas.agent.dormant") : t("canvas.agent.starting");

  const remove = () => dispatchCanvas(workspace, [{ op: "node.remove", page: pageId, id: node.id }]);
  const moveTo = (to: string) => {
    setMenu(false);
    dispatchCanvas(workspace, [{ op: "node.toPage", page: pageId, id: node.id, to }]);
  };

  return (
    // Sin `overflow-hidden` acá: los tiradores para agrandarlo van sobre el borde, mitad
    // afuera, y el menú de "mover a" baja por debajo de la cabecera. Recorta solo el cuerpo.
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`group relative h-full w-full flex flex-col rounded-lg
        bg-white dark:bg-surface-sunken shadow-sm
        ${selected || focused ? "ring-2 ring-accent-500/70" : "ring-1 ring-gray-300 dark:ring-white/10"}`}
      style={ring ? { boxShadow: `0 0 0 3px ${ring}, 0 0 24px ${ring}55` } : undefined}
    >
      <NodeResizer
        // También con el nodo enfocado o bajo el puntero: tocar su terminal no lo selecciona.
        isVisible={selected || focused || hover}
        minWidth={MIN_SIZE[node.kind].w}
        minHeight={MIN_SIZE[node.kind].h}
        lineClassName="!border-accent-500/60"
        handleClassName="!w-2.5 !h-2.5 !rounded-sm !bg-accent-500 !border-0"
      />

      <div
        className="cc-drag flex items-center gap-2 px-2.5 shrink-0 cursor-grab active:cursor-grabbing select-none rounded-t-lg
          border-b border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-surface"
        style={{ height: NODE_HEADER, ...(own ? { boxShadow: `inset 3px 0 0 ${own}` } : {}) }}
        onDoubleClick={() => centerOn(workspace, pageId, node.id)}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/50" />
        <span className="truncate text-xs font-medium text-gray-700 dark:text-white/80">{title}</span>
        {state && <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/35">{state}</span>}
        {touching && (
          <span className="shrink-0 px-1.5 rounded text-[10px] font-medium text-white" style={{ background: ring! }}>
            {touching.label}
          </span>
        )}
        <div className="flex-1" />
        <div className="nodrag flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {(node.kind === "diagram" || node.kind === "doc" || node.kind === "slides") && node.ref && (
            <HeaderButton label={t("canvas.node.openTab")} onClick={() => openInTab(workspace, node.ref!)}>
              <ExternalIcon className="w-3.5 h-3.5" />
            </HeaderButton>
          )}
          {node.kind !== "note" && (
            <HeaderButton label={t("canvas.node.focus")} onClick={() => centerOn(workspace, pageId, node.id)}>
              <ZoomInIcon className="w-3.5 h-3.5" />
            </HeaderButton>
          )}
          {pages.length > 0 && (
            <div className="relative">
              <HeaderButton label={t("canvas.node.moveTo")} onClick={() => setMenu((m) => !m)}>
                <span className="text-[11px] leading-none">⇄</span>
              </HeaderButton>
              {menu && (
                <div className="absolute right-0 top-6 z-10 min-w-36 py-1 rounded-md shadow-lg
                  bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10">
                  {pages.map((p) => (
                    <button key={p.id} onClick={() => moveTo(p.id)}
                      className="block w-full text-left px-3 py-1 text-xs text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/8">
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <HeaderButton label={t("canvas.node.remove")} onClick={remove}>
            <CloseIcon className="w-3.5 h-3.5" />
          </HeaderButton>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden rounded-b-lg">
        {node.kind === "note" ? (
          <NoteBody node={node} workspace={workspace} pageId={pageId} />
        ) : node.kind === "diagram" && node.ref ? (
          // El diagrama se dibuja acá mismo. Con zoom no responde al puntero (React Flow mide
          // mal dentro de algo escalado): un click lo lleva a 100%, donde se edita.
          <>
            {live && (
              <Suspense fallback={null}>
                <DiagramEditor path={node.ref} interactive={!inert} />
              </Suspense>
            )}
            {(inert || !live) && (
              <button
                className="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
                onClick={() => centerOn(workspace, pageId, node.id)}
              >
                {!live && t("canvas.node.zoomIn")}
              </button>
            )}
          </>
        ) : node.kind === "slides" && node.ref ? (
          // La presentación: la hoja actual y sus vecinas, recorrible acá mismo.
          <>
            {live && (
              <Suspense fallback={null}>
                <SlidesView dir={node.ref} interactive={!inert} />
              </Suspense>
            )}
            {(inert || !live) && (
              <button
                className="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
                onClick={() => centerOn(workspace, pageId, node.id)}
              >
                {!live && t("canvas.node.zoomIn")}
              </button>
            )}
          </>
        ) : node.kind === "doc" && node.ref ? (
          // El documento en vivo. Con zoom, la rueda mueve el canvas y un click lo lleva a 100%.
          <>
            {live && (
              <Suspense fallback={null}>
                <DocView path={node.ref} workspace={workspace} interactive={!inert} />
              </Suspense>
            )}
            {(inert || !live) && (
              <button
                className="absolute inset-0 flex items-center justify-center text-xs text-gray-400"
                onClick={() => centerOn(workspace, pageId, node.id)}
              >
                {!live && t("canvas.node.zoomIn")}
              </button>
            )}
          </>
        ) : (
          // El hueco: con la terminal o la página encima no se ve. Con zoom, la terminal no
          // recibe el puntero (xterm mide mal el mouse escalado) y el click cae acá.
          <button
            className={`absolute inset-0 flex items-center justify-center p-4 text-center text-xs
              text-gray-400 dark:text-white/30 bg-gray-100 dark:bg-surface-deep ${inert || !live ? "cursor-pointer" : ""}`}
            onClick={() => (live ? focusNode(node) : centerOn(workspace, pageId, node.id))}
          >
            {missing ? t("canvas.node.closed") : live ? "" : node.kind === "agent" && dormant ? t("canvas.node.wakeOnShow") : t("canvas.node.zoomIn")}
          </button>
        )}
      </div>
    </div>
  );
});

/** Abre el diagrama o el documento en una tab de archivo (que lo muestra como diagrama, o
 *  en vista previa), y pasa a las tabs para verla. */
function openInTab(workspace: string, path: string) {
  const cwd = agentsOf(workspace)[0]?.cwd ?? workspace;
  setCanvasMode(workspace, false);
  const views = useViewTabsStore.getState();
  // Una presentación se abre por su deck.json, que la tab muestra como presentación.
  const file = /\.slides[\\/]*$/i.test(path) ? `${path.replace(/[\\/]+$/, "")}/deck.json` : path;
  views.openFile(cwd, file);
  const view = useViewTabsStore.getState().views.find((v) => v.kind === "file" && v.path === file);
  if (view && /\.(md|markdown|mdx)$/i.test(path)) views.updateView(view.id, { preview: true });
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex items-center justify-center w-5 h-5 rounded text-gray-400 dark:text-white/40
        hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/** El texto de una nota: se edita ahí mismo y se guarda al dejar de escribir. */
function NoteBody({ node, workspace, pageId }: { node: CanvasNode; workspace: string; pageId: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState(node.text ?? "");
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lo que escribe un agente llega mientras no se esté escribiendo acá.
  useEffect(() => {
    if (!editing.current) setText(node.text ?? "");
  }, [node.text]);

  const commit = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value === (node.text ?? "")) return;
    try {
      dispatchCanvas(workspace, [{ op: "node.update", page: pageId, id: node.id, patch: { text: value } }]);
    } catch {
      /* el nodo se borró mientras se escribía */
    }
  };

  return (
    <textarea
      value={text}
      placeholder={t("canvas.note.placeholder")}
      onFocus={() => (editing.current = true)}
      onBlur={(e) => {
        editing.current = false;
        commit(e.target.value);
      }}
      onChange={(e) => {
        const value = e.target.value;
        setText(value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(value), 600);
      }}
      className="nodrag nowheel absolute inset-0 w-full h-full resize-none p-3 text-[13px] leading-relaxed outline-none
        bg-amber-50 text-gray-800 dark:bg-surface dark:text-white/85 placeholder:text-gray-400 dark:placeholder:text-white/25"
    />
  );
}
