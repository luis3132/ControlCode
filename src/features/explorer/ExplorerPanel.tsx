import { useTranslation } from "react-i18next";
import { DocumentIcon, SearchIcon, Tooltip } from "neogestify-ui-components";

import { useUiStore, type ExplorerView } from "@/app/uiStore";
import { BranchIcon, PanelIcon } from "@/app/icons";
import { FilesView } from "@/features/explorer/FilesView";
import type { RepoInfo } from "@/features/explorer/types";
import { SearchPanel } from "@/features/search/SearchPanel";
import { ScmPanel } from "@/features/scm/ScmPanel";

const SECTIONS: { view: ExplorerView; Icon: (p: { className: string }) => React.JSX.Element; label: string }[] = [
  { view: "files", Icon: DocumentIcon, label: "explorer.tab.files" },
  { view: "search", Icon: SearchIcon, label: "explorer.tab.search" },
  { view: "scm", Icon: BranchIcon, label: "explorer.tab.changes" },
];

/** Un icono de sección. El mismo botón en el panel desplegado y en la columna plegada. */
function SectionButton({ view, Icon, label, active, changes, placement }: {
  view: ExplorerView;
  Icon: (p: { className: string }) => React.JSX.Element;
  label: string;
  active: boolean;
  changes: number;
  placement: "left" | "bottom";
}) {
  const { t } = useTranslation();
  const openExplorer = useUiStore((s) => s.openExplorer);
  const toggle = useUiStore((s) => s.toggleExplorer);
  const collapsed = useUiStore((s) => s.explorerCollapsed);

  return (
    <Tooltip content={t(label)} placement={placement}>
      <button
        // Con el panel abierto, volver a apretar la sección que ya se ve lo pliega: es el
        // gesto de cualquier barra de actividades, y ahorra ir a buscar el otro botón.
        onClick={() => (active && !collapsed ? toggle() : openExplorer(view))}
        aria-label={t(label)}
        aria-pressed={active && !collapsed}
        className={`cc-t relative flex items-center justify-center w-8 h-8 rounded-lg shrink-0
          ${active && !collapsed
            ? "bg-blue-500/12 dark:bg-blue-400/13 text-blue-600 dark:text-blue-400"
            : "text-gray-500 dark:text-white/40 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/8"}`}
      >
        <Icon className="w-4 h-4" />
        {view === "scm" && changes > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full
            bg-amber-500 text-white text-[8.5px] font-bold leading-[14px] tabular-nums text-center">
            {changes > 99 ? "99+" : changes}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * El panel derecho del workspace activo: archivos, buscador y control de versiones.
 *
 * Va de este lado y no del izquierdo a propósito: un IDE abre con el árbol porque lo
 * primero es el código; acá lo primero son los agentes, y los archivos son el panel
 * secundario. Lo que se abre desde acá (un archivo, un diff) va como tab en la barra de
 * arriba, al lado de los agentes.
 *
 * La navegación son solo iconos: con tres secciones, los rótulos no entraban sin cortarse
 * y el tooltip ya dice qué es cada una.
 */
export function ExplorerPanel({ cwd, repo, title }: {
  cwd: string | null;
  repo: RepoInfo | null;
  title: string;
}) {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.explorerCollapsed);
  const view = useUiStore((s) => s.explorerView);
  const toggle = useUiStore((s) => s.toggleExplorer);
  const changes = repo?.changedCount ?? 0;

  if (collapsed) {
    return (
      <aside className="cc-fade flex flex-col items-center gap-1 w-11 shrink-0 pt-2
        bg-gray-50 dark:bg-[#0a0f16]
        border-l border-gray-200 dark:border-white/7">
        {SECTIONS.map((s) => (
          <SectionButton key={s.view} {...s} active={false} changes={changes} placement="left" />
        ))}
      </aside>
    );
  }

  return (
    <aside className="cc-fade flex flex-col shrink-0 min-h-0 w-72
      bg-gray-50 dark:bg-[#0a0f16]
      border-l border-gray-200 dark:border-white/7">

      <div className="flex items-center gap-1 h-10 shrink-0 pl-2 pr-1.5
        border-b border-gray-200 dark:border-white/7">
        {SECTIONS.map((s) => (
          <SectionButton key={s.view} {...s} active={s.view === view} changes={changes} placement="bottom" />
        ))}
        <div className="flex-1" />
        <Tooltip content={t("panel.collapse")} placement="left">
          <button onClick={toggle} aria-label={t("panel.collapse")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200/60 dark:hover:bg-white/8">
            <PanelIcon className="w-[15px] h-[15px]" />
          </button>
        </Tooltip>
      </div>

      {view === "files" && <FilesView cwd={cwd} repo={repo} title={title} />}
      {view === "search" && <SearchPanel cwd={cwd} />}
      {view === "scm" && <ScmPanel cwd={cwd} />}
    </aside>
  );
}
