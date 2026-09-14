import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDownIcon, ChevronRightIcon, DocumentIcon, FolderIcon, Skeleton, Tooltip } from "neogestify-ui-components";

import { DotsIcon, FolderOpenIcon, RefreshIcon } from "@/app/icons";
import { readDir } from "@/features/explorer/ipc";
import { flattenTree, toggleExpanded } from "@/features/explorer/tree";
import type { DirEntry, FileMark, RepoInfo } from "@/features/explorer/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";

/** Cada marca con su color. El conflicto en rojo porque es lo único que bloquea. */
export const MARK_CLASS: Record<FileMark, string> = {
  U: "text-red-500 dark:text-red-400",
  A: "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-500 dark:text-red-400",
  "?": "text-gray-400 dark:text-white/35",
};

/**
 * El árbol de archivos del workspace. Lee un nivel por vez — recursar un repo con
 * `node_modules` tarda segundos.
 *
 * Un click en un archivo lo abre como tab, al lado de los agentes: es lo que se hace con
 * un archivo casi siempre. Mostrarlo en el gestor de archivos del sistema sigue estando,
 * en el botón de la franja.
 */
export function FilesView({ cwd, repo, title }: {
  cwd: string | null;
  repo: RepoInfo | null;
  title: string;
}) {
  const { t } = useTranslation();
  const openFile = useViewTabsStore((s) => s.openFile);
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

  const onRowClick = (entry: DirEntry) => {
    setSelected(entry.path);
    if (entry.isDir) {
      const next = toggleExpanded(expanded, entry.path);
      setExpanded(next);
      if (next.has(entry.path) && !loaded.has(entry.path)) load(entry.path);
      return;
    }
    if (cwd) openFile(cwd, entry.path);
  };

  // Refrescar vuelve a leer lo que estaba abierto, no colapsa el árbol: con tres niveles
  // desplegados, perderlos para ver un archivo nuevo que creó el agente es un castigo.
  const refresh = () => {
    if (!cwd) return;
    load(cwd, true);
    expanded.forEach((dir) => load(dir));
  };

  return (
    <>
      <div className="flex items-center gap-2 h-8 shrink-0 pl-3.5 pr-1.5
        bg-gray-100/60 dark:bg-white/2">
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold tracking-tight
          text-gray-800 dark:text-gray-200">
          {title}
        </span>
        <Tooltip content={t("explorer.refresh")} placement="bottom">
          <button
            onClick={refresh}
            aria-label={t("explorer.refresh")}
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
            aria-label={t("explorer.reveal")}
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
                style={{ paddingLeft: 8 + depth * 13 }}
                title={entry.isDir ? undefined : t("explorer.openFile")}
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
    </>
  );
}
