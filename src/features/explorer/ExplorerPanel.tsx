import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDownIcon, ChevronRightIcon, DocumentIcon } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { BranchIcon, DotsIcon, PanelIcon, RefreshIcon } from "@/app/icons";
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

function HeaderTab({ active, title, onClick, children }: {
  active: boolean; title: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-colors
        ${active
          ? "text-gray-900 dark:text-white bg-gray-200/70 dark:bg-white/8"
          : "text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
    >
      {children}
    </button>
  );
}

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback((dir: string) => {
    readDir(dir)
      .then((entries) => setLoaded((prev) => new Map(prev).set(dir, entries)))
      // Una carpeta sin permisos o recién borrada no puede tumbar el panel entero.
      .catch(() => setLoaded((prev) => new Map(prev).set(dir, [])));
  }, []);

  // Cambiar de tab cambia de carpeta: lo leído de la anterior no sirve y mantenerlo haría
  // que el árbol muestre por un instante los archivos de otro proyecto.
  useEffect(() => {
    setLoaded(new Map());
    setExpanded(new Set());
    setSelected(null);
    if (cwd) load(cwd);
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
      <aside className="flex flex-col items-center gap-1 w-11 shrink-0 pt-2
        bg-gray-50 dark:bg-[#0a0f16]
        border-l border-gray-200 dark:border-white/7">
        <HeaderTab active title={t("explorer.files")} onClick={toggle}>
          <DocumentIcon className="w-4 h-4" />
        </HeaderTab>
        <HeaderTab active={false} title={t("explorer.changes")} onClick={toggle}>
          <span className="relative flex">
            <BranchIcon className="w-4 h-4" />
            {(repo?.changedCount ?? 0) > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </span>
        </HeaderTab>
      </aside>
    );
  }

  return (
    <aside className="flex flex-col shrink-0 min-h-0 w-67
      bg-gray-50 dark:bg-[#0a0f16]
      border-l border-gray-200 dark:border-white/7">

      <div className="flex items-center gap-0.5 h-10 shrink-0 px-2
        border-b border-gray-200 dark:border-white/7">
        <HeaderTab active={view === "files"} title={t("explorer.files")} onClick={() => setView("files")}>
          <DocumentIcon className="w-4 h-4" />
        </HeaderTab>
        <HeaderTab active={view === "changes"} title={t("explorer.changes")} onClick={() => setView("changes")}>
          <span className="relative flex">
            <BranchIcon className="w-4 h-4" />
            {(repo?.changedCount ?? 0) > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </span>
        </HeaderTab>
        <div className="flex-1" />
        <HeaderTab active={false} title={t("panel.collapse")} onClick={toggle}>
          <PanelIcon className="w-[15px] h-[15px]" />
        </HeaderTab>
      </div>

      <div className="flex items-center gap-2 h-8 shrink-0 pl-3.5 pr-1.5
        bg-gray-100/60 dark:bg-white/2">
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold tracking-tight
          text-gray-800 dark:text-gray-200">
          {title}
        </span>
        <button
          onClick={() => { if (cwd) { setLoaded(new Map()); setExpanded(new Set()); load(cwd); } }}
          title={t("explorer.refresh")}
          className="flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
            text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
            hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
        >
          <RefreshIcon className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => { if (selected) revealItemInDir(selected).catch(console.error); }}
          disabled={!selected}
          title={t("explorer.reveal")}
          className="flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
            text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
            hover:bg-gray-200 dark:hover:bg-white/10 transition-colors
            disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <DotsIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 cc-scroll py-1">
        {!cwd ? (
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
          rows.map(({ entry, depth, isExpanded, mark }) => (
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
              <DocumentIcon className={`w-3.5 h-3.5 shrink-0
                ${entry.isHidden ? "text-gray-300 dark:text-white/20" : "text-gray-400 dark:text-white/35"}`} />
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
          ))
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
