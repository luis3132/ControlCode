import { useTranslation } from "react-i18next";
import { DocumentIcon } from "neogestify-ui-components";

import { BranchIcon, GlobeIcon } from "@/app/icons";

import type { ViewTab } from "./viewTabs";

const ICON = { file: DocumentIcon, diff: BranchIcon, browser: GlobeIcon } as const;

/**
 * Una tab de archivo, diff o navegador en la barra de arriba.
 *
 * Mismo alto, forma y línea de activa que la de un agente —conviven en la misma tira—,
 * pero en cursiva y sin punto de estado: no hay proceso del que informar, y la cursiva es
 * lo que deja distinguir de un vistazo "esto es un agente" de "esto es algo que abrí".
 */
export function ViewTabItem({
  view, tabKey, className = "", hint, isActive, groupFocused = true, onActivate, onClose, onPointerDown, onContextMenu,
}: {
  view: ViewTab;
  /** La clave de la tab en los grupos: el arrastre la busca por ahí. */
  tabKey: string;
  className?: string;
  hint: string | null;
  isActive: boolean;
  /** `false` en un grupo sin el foco: la línea de la activa va en gris. */
  groupFocused?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const Icon = ICON[view.kind];
  const dirty = view.kind === "file" && view.dirty;
  const title = view.title || (view.kind === "browser" ? t("browser.newTab") : "");

  return (
    <div
      data-tab-key={tabKey}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu && ((e) => { e.preventDefault(); onContextMenu(e); })}
      onClick={onActivate}
      // Click del medio cierra, como en cualquier navegador o editor.
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      title={view.kind === "browser" ? view.url || title : view.kind === "file" ? view.path : `${view.root}/${view.path}`}
      className={`group relative flex items-center gap-2 h-10 pl-3 pr-1.5 shrink-0
        max-w-52 min-w-24 rounded-t-[9px] cursor-pointer select-none transition-colors duration-150 ${className}
        ${isActive
          ? "bg-gray-50 dark:bg-[#0d1117] text-gray-900 dark:text-white"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-200/50 dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-200"}`}
    >
      {isActive && (
        <span className={`absolute bottom-0 left-0 right-0 h-[2px] ${groupFocused ? "bg-blue-500" : "bg-gray-300 dark:bg-white/20"}`} />
      )}

      <Icon className={`w-3.5 h-3.5 shrink-0 opacity-70 ${view.kind === "diff" ? "text-amber-500" : ""}`} />
      <span className="flex-1 min-w-0 truncate text-xs italic">
        {title}
        {hint && <span className="not-italic text-[10px] text-gray-400 dark:text-white/30"> · {hint}</span>}
      </span>

      {/* Sin guardar: el punto ocupa el lugar de la cruz hasta que se pasa el mouse, igual que
          en los editores. Cerrar igual pide confirmación. */}
      {dirty && (
        <span className="absolute right-3 w-2 h-2 rounded-full bg-gray-500 dark:bg-white/60 group-hover:opacity-0" />
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onMouseDown={(e) => e.stopPropagation()}
        title={t("btn.close")}
        className={`shrink-0 flex items-center justify-center w-4 h-4 rounded
          text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/15 transition-opacity duration-100
          ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"} ${dirty ? "opacity-0 group-hover:opacity-100" : ""}`}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
