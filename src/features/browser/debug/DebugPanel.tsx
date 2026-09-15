import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { CloseIcon } from "neogestify-ui-components";

import { currentCounts, EMPTY_LOG } from "../debugLog";
import { useDebugStore } from "../debugStore";
import type { PageChannel } from "../pageChannel";
import { ConsoleView } from "./ConsoleView";
import { NetworkView } from "./NetworkView";
import { PerformanceView } from "./PerformanceView";
import { StorageView } from "./StorageView";

export type DebugTab = "console" | "network" | "storage" | "performance";

const TABS: DebugTab[] = ["console", "network", "storage", "performance"];

export const MIN_PANEL = 140;

/**
 * El panel de debug de la página, abajo como en las devtools de cualquier navegador.
 *
 * Solo la pestaña visible está montada: la red y el rendimiento sondean mientras se miran,
 * y seguir haciéndolo con el panel en otra pestaña sería trabajo que nadie ve. La consola
 * no pierde nada por eso — se registra siempre, esté o no abierta.
 */
export function DebugPanel({ viewId, channel, proxyOrigin, targetOrigin, docId, tab, onTab, height, onHeight, onClose }: {
  viewId: string;
  channel: PageChannel;
  proxyOrigin: string | null;
  targetOrigin: string | null;
  docId: string | null;
  tab: DebugTab;
  onTab: (tab: DebugTab) => void;
  height: number;
  onHeight: (height: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // `useShallow`: el selector arma un objeto nuevo en cada llamada, y zustand 5 lo tomaría
  // como un cambio perpetuo y volvería a pintar sin fin.
  const counts = useDebugStore(useShallow((s) => currentCounts(s.logs[viewId] ?? EMPTY_LOG)));
  const [dragging, setDragging] = useState(false);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = height;
    // El panel no puede tapar la página entera: siempre queda algo arriba para ver.
    const max = Math.max(MIN_PANEL, (handle.closest("[data-browser-column]")?.clientHeight ?? 800) - 120);
    setDragging(true);
    const move = (ev: PointerEvent) => onHeight(Math.round(Math.min(max, Math.max(MIN_PANEL, startHeight + startY - ev.clientY))));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div style={{ height }} className="relative flex flex-col shrink-0 min-h-0 bg-gray-50 dark:bg-[#0b0f15]
      border-t border-gray-300 dark:border-white/10">
      <div role="separator" aria-orientation="horizontal" onPointerDown={startResize}
        className="absolute -top-1 inset-x-0 h-2 z-10 cursor-ns-resize touch-none hover:bg-blue-500/30" />
      {dragging && <div className="fixed inset-0 z-50" style={{ cursor: "ns-resize" }} />}

      <div role="tablist" className="flex items-center gap-0.5 h-8 shrink-0 px-1.5 border-b border-gray-200 dark:border-white/7">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={`cc-t relative flex items-center gap-1.5 h-8 px-2.5 text-[11.5px] font-medium
              ${tab === id
                ? "text-gray-900 dark:text-white after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-blue-500"
                : "text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white"}`}
          >
            {t(`browser.debug.tab.${id}`)}
            {id === "console" && counts.errors > 0 && (
              <span className="min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[9.5px] font-bold leading-4 text-center tabular-nums">
                {counts.errors}
              </span>
            )}
            {id === "console" && counts.errors === 0 && counts.warnings > 0 && (
              <span className="min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[9.5px] font-bold leading-4 text-center tabular-nums">
                {counts.warnings}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={onClose} aria-label={t("btn.close")}
          className="cc-t flex items-center justify-center w-6 h-6 rounded-md
            text-gray-400 dark:text-white/35 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "console" && <ConsoleView viewId={viewId} channel={channel} />}
        {tab === "network" && <NetworkView viewId={viewId} proxyOrigin={proxyOrigin} targetOrigin={targetOrigin} />}
        {tab === "storage" && <StorageView channel={channel} proxyOrigin={proxyOrigin} docId={docId} />}
        {tab === "performance" && <PerformanceView channel={channel} docId={docId} />}
      </div>
    </div>
  );
}
