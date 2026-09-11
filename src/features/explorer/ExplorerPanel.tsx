import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Badge, ChevronDownIcon, ChevronRightIcon, DocumentIcon, FolderIcon, Skeleton, Tabs, Tooltip,
} from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { BranchIcon, DotsIcon, FolderOpenIcon, PanelIcon, RefreshIcon } from "@/app/icons";
import { readDir } from "@/features/explorer/ipc";
import { flattenTree, toggleExpanded } from "@/features/explorer/tree";
import type { DirEntry, FileMark, RepoInfo } from "@/features/explorer/types";

type View = "files" | "changes";

/** Cada marca con su color. El conflicto en rojo porque es lo único que bloquea. */
const MARK_CLASS: Record<FileMark, string> = {
  U: "text-red-500 dark:text-red-400",
  A: "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-500 dark:text-red-400",
  "?": "text-gray-400 dark:text-white/35",
};

/**
 * El explorador del workspace activo, a la derecha.
 *
 * Va de este lado y no del izquierdo a propósito: un IDE abre con el árbol porque lo
 * primero es el código; acá lo primero son los agentes, y los archivos son el panel
 * secundario. Lee un nivel por vez — recursar un repo con `node_modules` tarda segundos.
 */
export function ExplorerPanel({ cwd, repo, title }: {
  cwd: string | null;
  repo: RepoInfo | null;
  title: string;
}) {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.explorerCollapsed);
  const toggle = useUiStore((s) => s.toggleExplorer);
  const [view, setView] = useState<View>("files");
  const [loaded, setLoaded] = useState<Map<string, DirEntry[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback((dir: string, root = false) => {
    if (root) setLoading(true);
    readDir(dir)
      .then((entries) => setLoaded((prev) => new Map(prev).set(dir, entries)))
      // Una carpeta sin permisos o recién borrada no puede tumbar el panel entero.
      .catch(() => setLoaded((prev) => new Map(prev).set(dir, [])))
      .finally(() => { if (root) setLoading(false); });
  }, []);

  // Cambiar de tab cambia de carpeta: lo leído de la anterior no sirve y mantenerlo haría
  // que el árbol muestre por un instante los archivos de otro proyecto.
  useEffect(() => {
    setLoaded(new Map());
    setExpanded(new Set());
    setSelected(null);
    if (cwd) load(cwd, true);
  }, [cwd, load]);

  const rows = useMemo(
    () => (cwd ? flattenTree(cwd, loaded, expanded, repo) : []),
    [cwd, loaded, expanded, repo]
  );

  const changed = useMemo(() => {
    if (!repo?.root) return [];
    return Object.entries(repo.changes)
      .map(([rel, mark]) => ({ rel, mark }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }, [repo]);

  const onRowClick = (entry: DirEntry) => {
    if (entry.isDir) {
      const next = toggleExpanded(expanded, entry.path);
      setExpanded(next);
      if (next.has(entry.path) && !loaded.has(entry.path)) load(entry.path);
      return;
    }
    setSelected(entry.path);
  };

  if (collapsed) {
    return (
      <aside className="cc-fade flex flex-col items-center gap-1 w-11 shrink-0 pt-2
        bg-gray-50 dark:bg-[#0a0f16]
        border-l border-gray-200 dark:border-white/7">
        <Tooltip content={t("panel.expand")} placement="left">
          <button onClick={toggle} className="cc-t flex items-center justify-center w-8 h-8 rounded-lg
            text-gray-500 dark:text-white/40
            hover:text-gray-900 dark:hover:text-white
            hover:bg-gray-200/60 dark:hover:bg-white/8">
            <DocumentIcon className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={t("explorer.changes")} placement="left">
          <button onClick={toggle} className="cc-t relative flex items-center justify-center w-8 h-8 rounded-lg
            text-gray-500 dark:text-white/40
            hover:text-gray-900 dark:hover:text-white
            hover:bg-gray-200/60 dark:hover:bg-white/8">
            <BranchIcon className="w-4 h-4" />
            {(repo?.changedCount ?? 0) > 0 && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="cc-fade flex flex-col shrink-0 min-h-0 w-67
      bg-gray-50 dark:bg-[#0a0f16]
      border-l border-gray-200 dark:border-white/7">

      {/* Sin alto fijo: `Tabs size="sm"` mide lo que midan sus paddings (~30px), y
          forzarle una franja de 40px dejaba el fondo del hover más corto que la fila —
          se veían dos barras, arriba y abajo de la pestaña. La fila se ajusta al
          contenido y el problema desaparece de raíz. */}
      <div className="flex items-center gap-1 shrink-0 py-1 pl-2 pr-1.5
        border-b border-gray-200 dark:border-white/7">
        <Tabs
          items={[
            { id: "files", label: t("explorer.tab.files"), icon: <DocumentIcon className="w-3.5 h-3.5" /> },
            {
              id: "changes",
              label: t("explorer.tab.changes"),
              icon: <BranchIcon className="w-3.5 h-3.5" />,
              badge: repo?.changedCount ? (
                <Badge variant="warning" size="sm" pill>{repo.changedCount}</Badge>
              ) : undefined,
            },
          ]}
          value={view}
          onChange={(id) => setView(id as View)}
          variant="line"
          size="sm"
          className="flex-1 min-w-0"
        />
        <Tooltip content={t("panel.collapse")} placement="left">
          <button onClick={toggle} className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0
            text-gray-400 dark:text-white/35
            hover:text-gray-700 dark:hover:text-white
            hover:bg-gray-200/60 dark:hover:bg-white/8">
            <PanelIcon className="w-[15px] h-[15px]" />
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center gap-2 h-8 shrink-0 pl-3.5 pr-1.5
        bg-gray-100/60 dark:bg-white/2">
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold tracking-tight
          text-gray-800 dark:text-gray-200">
          {title}
        </span>
        <Tooltip content={t("explorer.refresh")} placement="bottom">
          <button
            onClick={() => { if (cwd) { setLoaded(new Map()); setExpanded(new Set()); load(cwd, true); } }}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t("explorer.reveal")} placement="bottom" disabled={!selected}>
          <button
            onClick={() => { if (selected) revealItemInDir(selected).catch(console.error); }}
            disabled={!selected}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10
              disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <DotsIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll py-1">
        {loading && rows.length === 0 ? (
          <div className="flex flex-col gap-1.5 px-3.5 py-2">
            {[64, 48, 72, 40, 56, 68].map((w, i) => (
              <Skeleton key={i} variant="text" height={12} width={`${w}%`} />
            ))}
          </div>
        ) : !cwd ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">
            {t("explorer.noTab")}
          </p>
        ) : view === "changes" ? (
          changed.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">
              {t("explorer.noChanges")}
            </p>
          ) : (
            changed.map(({ rel, mark }) => (
              <div key={rel} className="flex items-center gap-2 h-[22px] pl-3.5 pr-2">
                <span className={`shrink-0 w-3 font-mono text-[9.5px] text-center ${MARK_CLASS[mark]}`}>
                  {mark}
                </span>
                <span className="flex-1 min-w-0 truncate text-[11.5px] text-gray-600 dark:text-gray-400"
                  title={rel} dir="rtl">
                  {rel}
                </span>
              </div>
            ))
          )
        ) : (
          rows.map(({ entry, depth, isExpanded, mark }) => {
            // Carpeta abierta / cerrada / archivo. Que la carpeta desplegada cambie de
            // icono no duplica al chevron: el chevron dice "esto se puede plegar" y vive
            // en la columna de la jerarquía; el icono dice qué ES la fila.
            const Icon = entry.isDir
              ? (isExpanded ? FolderOpenIcon : FolderIcon)
              : DocumentIcon;
            return (
            <button
              key={entry.path}
              onClick={() => onRowClick(entry)}
              onDoubleClick={() => revealItemInDir(entry.path).catch(console.error)}
              style={{ paddingLeft: 8 + depth * 13 }}
              className={`flex items-center gap-1.5 h-[22px] w-full pr-2 text-left
                transition-colors duration-100
                ${selected === entry.path
                  ? "bg-blue-500/12 dark:bg-blue-400/13"
                  : "hover:bg-gray-200/50 dark:hover:bg-white/4"}`}
            >
              <span className="w-3 shrink-0 flex items-center text-gray-400 dark:text-white/30">
                {entry.isDir && (isExpanded
                  ? <ChevronDownIcon className="w-2.5 h-2.5" />
                  : <ChevronRightIcon className="w-2.5 h-2.5" />)}
              </span>
              {/* La carpeta va un punto más marcada que el archivo: en una lista larga es
                  lo que deja separar la estructura del contenido de un vistazo, sin meter
                  un color que compita con el azul de la fila seleccionada. */}
              <Icon className={`w-3.5 h-3.5 shrink-0
                ${entry.isHidden
                  ? "text-gray-300 dark:text-white/20"
                  : entry.isDir
                    ? "text-gray-500 dark:text-white/50"
                    : "text-gray-400 dark:text-white/30"}`} />
              <span className={`flex-1 min-w-0 truncate text-[11.5px]
                ${entry.isDir ? "font-semibold" : ""}
                ${entry.isHidden
                  ? "text-gray-400 dark:text-white/30"
                  : "text-gray-700 dark:text-gray-300"}`}>
                {entry.name}
              </span>
              {mark && (
                <span className={`shrink-0 w-3 font-mono text-[9.5px] text-center ${MARK_CLASS[mark]}`}>
                  {mark}
                </span>
              )}
            </button>
            );
          })
        )}
      </div>

      {repo?.root && (
        <div className="flex items-center gap-2 h-7 shrink-0 px-3.5
          border-t border-gray-200 dark:border-white/7
          text-[10px] tabular-nums text-gray-400 dark:text-white/35">
          {repo.branch && (
            <span className="flex items-center gap-1.5 min-w-0">
              <BranchIcon className="w-3 h-3 shrink-0" />
              <span className="truncate font-mono">{repo.branch}</span>
            </span>
          )}
          <div className="flex-1" />
          {repo.changedCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400 shrink-0">
              {t("workspaces.changed", { n: repo.changedCount })}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
