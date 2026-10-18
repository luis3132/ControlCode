import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import { agentTile } from "@/features/agents/agentTile";
import { agentPaint } from "@/features/browser/agentPaint";
import { workspaceOf } from "@/features/canvas/actions";
import { requestView, setActivePage, setCanvasMode, useCanvasStore } from "@/features/canvas/store";
import { useRunsStore } from "@/features/runs/store";
import { activateItem } from "@/features/tabs/layout/layoutStore";
import { agentKey } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { useDocumentVisible } from "@/shared/useDocumentVisible";

import { canvasEdits, type CanvasEdit } from "./canvasEdits";

/** Cuántas se muestran; el resto se cuenta. */
const MAX_CARDS = 4;

/**
 * El aviso de la esquina: un agente está cambiando una ventana de un canvas que no estás
 * viendo (ver `canvasEdits.ts`). Dura lo que dura la edición —la presencia del canvas se
 * borra sola unos segundos después del último cambio— y un click lleva a esa ventana.
 *
 * No avisa de agentes trabajando en general: eso es lo normal, y un aviso fijo en la
 * esquina por cada uno solo estorbaba. Los permisos pendientes tienen su propio aviso
 * (`runs/ApprovalToast`).
 */
export function BackgroundAgents() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const docVisible = useDocumentVisible();
  const tabs = useTabsStore((s) => s.tabs);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
  const tasks = useRunsStore((s) => s.tasks);
  const pages = useCanvasStore((s) => s.pages);
  const canvasMode = useCanvasStore((s) => s.canvasMode);
  const activePage = useCanvasStore((s) => s.activePage);
  const presence = useCanvasStore((s) => s.presence);

  const shownWorkspace = pathname.startsWith("/workspace") && docVisible && activeCwd ? workspaceOf(activeCwd) : null;
  const edits = useMemo(
    () => canvasEdits({ pages, canvasMode, activePage, presence, shownWorkspace }),
    [pages, canvasMode, activePage, presence, shownWorkspace]
  );

  if (edits.length === 0) return null;

  /** El agente detrás del cambio: su tab o su tarea, para el logo. */
  const agentOf = (edit: CanvasEdit) =>
    tabs.find((tab) => tab.id === edit.actor.id) ?? tasks.find((task) => task.id === edit.actor.id) ?? null;

  const open = (edit: CanvasEdit) => {
    navigate("/workspace");
    // Para pasar a otro workspace se activa una de sus tabs: la del agente, si es de ahí.
    const tab = tabs.find((x) => x.id === edit.actor.id && workspaceOf(x.cwd) === edit.workspace)
      ?? tabs.find((x) => workspaceOf(x.cwd) === edit.workspace);
    if (tab) activateItem(agentKey(tab.id));
    setCanvasMode(edit.workspace, true);
    setActivePage(edit.workspace, edit.pageId);
    setTimeout(() => requestView({ workspace: edit.workspace, page: edit.pageId, focus: edit.nodeId }), 60);
  };

  return (
    <div
      className="cc-rise w-[300px] rounded-xl shadow-xl overflow-hidden
        bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10"
    >
      {edits.slice(0, MAX_CARDS).map((edit) => {
        const agent = agentOf(edit);
        const Icon = agentIcon(agent?.agentId ?? "", agent && "command" in agent ? agent.command : undefined);
        const what = edit.name ?? t(`background.kind.${edit.kind}`);
        return (
          <button
            key={edit.key}
            onClick={() => open(edit)}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/5"
            style={{ boxShadow: `inset 3px 0 0 ${agentPaint(edit.actor.id).hex}` }}
            title={t("background.open")}
          >
            <span
              className="shrink-0 flex items-center justify-center w-[30px] h-[30px] rounded-lg text-white shadow-sm"
              style={{ background: agentTile(agent?.agentId ?? "") }}
            >
              <Icon className="w-[55%] h-[55%]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-gray-800 dark:text-white/90">
                {t("background.editing", { agent: edit.actor.label, what })}
              </span>
              <span className="block truncate text-[11px] text-gray-500 dark:text-white/45">
                {t("background.where", { page: edit.pageName })}
              </span>
            </span>
            <span className="shrink-0 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          </button>
        );
      })}
      {edits.length > MAX_CARDS && (
        <p className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-white/35">
          {t("background.more", { count: edits.length - MAX_CARDS })}
        </p>
      )}
    </div>
  );
}
