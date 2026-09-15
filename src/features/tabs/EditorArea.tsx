import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AddIcon, CloseIcon } from "neogestify-ui-components";

import { GlobeIcon, SplitDownIcon, SplitRightIcon } from "@/app/icons";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { GroupTabStrip } from "@/features/tabs/GroupTabStrip";
import {
  closeGroupAt, focusGroup, resizeSplit, splitGroup, useLayoutStore, useWorkspaceLayout, type Rect,
} from "@/features/tabs/layout/layoutStore";
import { allGroups, type GroupNode, type LayoutNode, type SplitNode } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWizard } from "@/features/tabs/tabActions";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { ViewTabsHost } from "@/features/tabs/ViewTabsHost";

/**
 * El área de tabs, dividida en grupos como los editores de VS Code.
 *
 * ## El árbol no contiene a las terminales
 *
 * Lo natural sería dibujar cada terminal adentro de su grupo, pero React desmonta lo que
 * cambia de padre: mover una tab de grupo, o dividir, remontaría su xterm —y un navegador
 * perdería su página—. Así que el árbol dibuja solo lo que no tiene estado (las tiras, los
 * divisores, los huecos donde va el contenido) y mide esos huecos; `TerminalPanel` y
 * `ViewTabsHost` siguen dibujando todo en el mismo lugar de siempre y ubican cada tab visible
 * encima del hueco de su grupo.
 *
 * Por eso la capa del árbol va ARRIBA y no deja pasar el puntero salvo en sus partes
 * (tiras, divisores, grupos vacíos): los huecos son transparentes a los clicks, que llegan
 * a la terminal o al navegador de abajo.
 */
export function EditorArea() {
  const layout = useWorkspaceLayout();
  const containerRef = useRef<HTMLDivElement>(null);
  const groups = layout ? allGroups(layout.root) : [];
  const groupIds = groups.map((g) => g.id).join("|");

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    const slots: Record<string, Rect> = {};
    container.querySelectorAll<HTMLElement>("[data-slot]").forEach((el) => {
      const r = el.getBoundingClientRect();
      slots[el.dataset.slot!] = {
        left: Math.round(r.left - base.left),
        top: Math.round(r.top - base.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
    const prev = useLayoutStore.getState().slots;
    if (JSON.stringify(prev) !== JSON.stringify(slots)) useLayoutStore.setState({ slots });
  }, []);

  // Después de cada cambio del árbol (dividir, arrastrar un divisor), antes de pintar: así
  // las terminales ya están en su lugar nuevo en el mismo cuadro.
  useLayoutEffect(() => measure());

  // Y cuando cambia el tamaño sin que cambie el árbol: la ventana, el panel de la derecha.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    container.querySelectorAll("[data-slot]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [groupIds, measure]);

  return (
    <div ref={containerRef} data-editor-area className="absolute inset-0">
      {/* TerminalPanel siempre montado para preservar PTYs */}
      <TerminalPanel />
      {/* Archivos, diffs y navegadores: tabs que se dibujan encima de las terminales. */}
      <ViewTabsHost />
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
        {layout ? (
          <NodeView node={layout.root} focused={layout.focused} divided={groups.length > 1} />
        ) : (
          <div data-slot="" className="h-full" />
        )}
      </div>
      <TabDragOverlay />
    </div>
  );
}

function NodeView({ node, focused, divided }: { node: LayoutNode; focused: string; divided: boolean }) {
  if (node.kind === "group") return <GroupView group={node} focused={node.id === focused} divided={divided} />;
  return <SplitView split={node} focused={focused} divided={divided} />;
}

function SplitView({ split, focused, divided }: { split: SplitNode; focused: string; divided: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const row = split.direction === "row";
  return (
    <div ref={ref} className="flex h-full w-full min-w-0 min-h-0" style={{ flexDirection: row ? "row" : "column" }}>
      {split.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <Sash split={split} index={i - 1} containerRef={ref} />}
          <div className="relative min-w-0 min-h-0" style={{ flex: `${split.sizes[i] ?? 1} 1 0px` }}>
            <NodeView node={child} focused={focused} divided={divided} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Lo mínimo que se deja a cada lado al arrastrar un divisor. */
const MIN_PANE = 120;

/**
 * El divisor entre dos partes. Ocupa un píxel —el hueco de cada grupo se mide sin él— pero
 * se agarra desde unos píxeles más a cada lado.
 */
function Sash({ split, index, containerRef }: {
  split: SplitNode;
  index: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const row = split.direction === "row";
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    const box = container.getBoundingClientRect();
    // Los divisores ocupan 1px cada uno: lo que se reparte es el resto.
    const total = (row ? box.width : box.height) - (split.children.length - 1);
    const start = row ? e.clientX : e.clientY;
    const sizes = [...split.sizes];
    const pair = sizes[index]! + sizes[index + 1]!;
    const min = Math.min(MIN_PANE / total, pair / 2);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const delta = ((row ? ev.clientX : ev.clientY) - start) / total;
      const first = Math.min(pair - min, Math.max(min, sizes[index]! + delta));
      const next = [...sizes];
      next[index] = first;
      next[index + 1] = pair - first;
      resizeSplit(split.id, next);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setDragging(false);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  // Doble click: las dos partes a medias.
  const onDoubleClick = () => {
    const next = [...split.sizes];
    const pair = next[index]! + next[index + 1]!;
    next[index] = pair / 2;
    next[index + 1] = pair / 2;
    resizeSplit(split.id, next);
  };

  const cursor = row ? "col-resize" : "row-resize";
  return (
    <div className="relative shrink-0 bg-gray-200 dark:bg-gray-800" style={row ? { width: 1 } : { height: 1 }}>
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        className={`absolute pointer-events-auto z-10 transition-colors duration-150 delay-75
          ${dragging ? "bg-blue-500/70" : "hover:bg-blue-500/50"}`}
        style={row ? { top: 0, bottom: 0, left: -3, width: 7, cursor } : { left: 0, right: 0, top: -3, height: 7, cursor }}
      />
      {/* Mientras se arrastra, una capa encima de todo: sin ella, pasar sobre el navegador de
          una tab le entrega el puntero a su página y el cursor cambia. */}
      {dragging && createPortal(<div style={{ position: "fixed", inset: 0, zIndex: 2147483000, cursor }} />, document.body)}
    </div>
  );
}

function GroupView({ group, focused, divided }: { group: GroupNode; focused: boolean; divided: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const empty = group.items.length === 0;

  // Tocar el grupo lo enfoca, salvo sus botones: cerrar la tab de otro grupo, o dividirlo,
  // no es ponerse a trabajar ahí — y enfocarlo antes de cerrar movía el foco a donde no
  // estaba el usuario.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (!focused && !(e.target as HTMLElement).closest("button")) focusGroup(group.id);
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0 min-h-0" onPointerDownCapture={onPointerDownCapture}>
      {divided && (
        <div
          data-tab-strip={group.id}
          className="cc-scroll-x pointer-events-auto flex items-stretch h-10 shrink-0
            bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800"
        >
          <GroupTabStrip items={group.items} active={group.active} groupFocused={focused} draggable />
          <div className="flex-1" />
          <div data-strip-actions className="sticky right-0 flex items-center gap-0.5 px-1.5 shrink-0 bg-gray-100 dark:bg-gray-900">
            <GroupButton label={t("tabs.split.right")} onClick={() => splitGroup(group.id, "right", group.active)}>
              <SplitRightIcon className="w-3.5 h-3.5" />
            </GroupButton>
            <GroupButton label={t("tabs.split.down")} onClick={() => splitGroup(group.id, "down", group.active)}>
              <SplitDownIcon className="w-3.5 h-3.5" />
            </GroupButton>
            <GroupButton label={t("tabs.group.close")} onClick={() => closeGroupAt(group.id)}>
              <CloseIcon className="w-3.5 h-3.5" />
            </GroupButton>
          </div>
        </div>
      )}
      <div data-slot={group.id} className="relative flex-1 min-h-0">
        {empty && (
          <div className="absolute inset-0 pointer-events-auto flex flex-col items-center justify-center gap-4 px-6 text-center
            bg-gray-50 dark:bg-[#0d1117]">
            <p className="text-sm text-gray-500 dark:text-white/40">{t("tabs.group.empty")}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <EmptyAction
                onClick={() => {
                  focusGroup(group.id);
                  openNewAgentWizard();
                }}
              >
                <AddIcon className="w-4 h-4" />
                {t("tabs.new")}
              </EmptyAction>
              <EmptyAction
                onClick={() => {
                  focusGroup(group.id);
                  const { tabs, activeTabId } = useTabsStore.getState();
                  const cwd = tabs.find((tab) => tab.id === activeTabId)?.cwd;
                  if (cwd) useViewTabsStore.getState().openBrowser(cwd);
                  navigate("/workspace");
                }}
              >
                <GlobeIcon className="w-4 h-4" />
                {t("tabs.group.browser")}
              </EmptyAction>
            </div>
            <p className="text-xs text-gray-400 dark:text-white/25">{t("tabs.group.dropHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function GroupButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex items-center justify-center w-6 h-6 rounded-md
        text-gray-400 dark:text-white/30 hover:text-gray-700 dark:hover:text-white/80
        hover:bg-gray-200 dark:hover:bg-white/10 transition-colors duration-150"
    >
      {children}
    </button>
  );
}

function EmptyAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs
        border border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/60
        hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white transition-colors duration-150"
    >
      {children}
    </button>
  );
}

/**
 * Lo que se ve mientras se arrastra una tab: la zona donde caería y el nombre al lado del
 * puntero. Por un portal y con coordenadas de la ventana, porque la tira de la barra de
 * título está fuera del área de tabs.
 */
function TabDragOverlay() {
  const drag = useLayoutStore((s) => s.drag);
  if (!drag) return null;
  const { target } = drag;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 2147483000, pointerEvents: "none", cursor: "grabbing" }}>
      {target?.kind === "zone" && (
        <div
          className="rounded-md border-2 border-blue-500/70 bg-blue-500/15 transition-all duration-100"
          style={{ position: "fixed", left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height }}
        />
      )}
      {target?.kind === "strip" && (
        <div className="bg-blue-500" style={{ position: "fixed", left: target.lineX - 1, top: target.top + 6, width: 2, height: target.height - 12 }} />
      )}
      <div
        className="max-w-56 truncate px-2.5 py-1 rounded-md text-xs shadow-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900"
        style={{ position: "fixed", left: drag.x + 14, top: drag.y + 14 }}
      >
        {drag.label}
      </div>
    </div>,
    document.body
  );
}
