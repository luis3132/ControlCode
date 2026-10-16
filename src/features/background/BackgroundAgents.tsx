import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import { agentTile } from "@/features/agents/agentTile";
import { agentPaint } from "@/features/browser/agentPaint";
import { workspaceOf } from "@/features/canvas/actions";
import { pageOfAgent } from "@/features/canvas/model";
import { requestView, setActivePage, setCanvasMode, useCanvasStore } from "@/features/canvas/store";
import { useChatStore } from "@/features/chat/store";
import { useRunsStore } from "@/features/runs/store";
import { activateItem, usePlacements } from "@/features/tabs/layout/layoutStore";
import { agentKey, isAgentKey, keyId } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { ptyActivity, type PtyActivity } from "@/features/terminal/ipc";
import { useDocumentVisible } from "@/shared/useDocumentVisible";

import { backgroundAgents, type BackgroundAgent } from "./agents";

/** Cada cuánto se pregunta qué están haciendo las terminales. */
const POLL_MS = 2000;
/** Cuántas tarjetas se muestran desplegadas; el resto se cuenta. */
const MAX_CARDS = 5;
const COLLAPSED_KEY = "cc-background-collapsed";

/**
 * Los agentes que trabajan sin que se los vea, en la esquina de abajo a la derecha: las
 * tareas de la flota y los agentes de las tabs que no están a la vista. Con su logo, qué
 * están haciendo y, si pidieron permiso, que esperan a alguien. Un click lleva a cada uno.
 *
 * Desaparece cuando no hay ninguno: un "0 agentes" fijo en la esquina sería ruido.
 */
export function BackgroundAgents() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const docVisible = useDocumentVisible();
  const tabs = useTabsStore((s) => s.tabs);
  const chats = useChatStore((s) => s.chats);
  const tasks = useRunsStore((s) => s.tasks);
  const approvals = useRunsStore((s) => s.approvals);
  const taskActivity = useRunsStore((s) => s.activity);
  const { visible } = usePlacements();
  const [activity, setActivity] = useState<Record<number, PtyActivity>>({});
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Las terminales de agentes, a preguntar. Solo con la ventana a la vista: oculta, la
  // esquina tampoco se ve.
  const ptyIds = tabs
    .filter((tab) => tab.ptyId != null && tab.mode !== "html" && tab.agentId !== "bash")
    .map((tab) => tab.ptyId!)
    .join(",");
  useEffect(() => {
    if (!ptyIds || !docVisible) {
      setActivity({});
      return;
    }
    let alive = true;
    const ids = ptyIds.split(",").map(Number);
    const poll = () =>
      ptyActivity(ids)
        .then((raw) => {
          if (alive) setActivity(Object.fromEntries(Object.entries(raw).map(([k, v]) => [Number(k), v])));
        })
        .catch(() => {});
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ptyIds, docVisible]);

  const onWorkspace = pathname.startsWith("/workspace");
  const visibleTabs = useMemo(
    () => new Set(onWorkspace && docVisible ? [...visible.keys()].filter(isAgentKey).map(keyId) : []),
    [visible, onWorkspace, docVisible]
  );

  const agents = useMemo(
    () => backgroundAgents({
      tabs, visibleTabs, activity, chats, tasks, approvals, taskActivity, fleetVisible: pathname.startsWith("/fleet"),
    }),
    [tabs, visibleTabs, activity, chats, tasks, approvals, taskActivity, pathname]
  );

  if (agents.length === 0) return null;

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* no recordarlo no impide plegarla */
      }
      return !c;
    });
  };

  const open = (agent: BackgroundAgent) => {
    if (agent.kind === "task") {
      navigate("/fleet");
      return;
    }
    const tab = tabs.find((x) => x.id === agent.id);
    if (!tab) return;
    const workspace = workspaceOf(tab.cwd);
    const canvas = useCanvasStore.getState();
    navigate("/workspace");
    if (canvas.canvasMode[workspace]) {
      // En el canvas, a su nodo; si no está en ninguna página, a las tabs.
      const page = pageOfAgent(canvas.pages[workspace] ?? [], tab.id);
      const node = page?.nodes.find((n) => n.kind === "agent" && n.ref === tab.id);
      if (page && node) {
        activateItem(agentKey(tab.id));
        setActivePage(workspace, page.id);
        setTimeout(() => requestView({ workspace, page: page.id, focus: node.id }), 60);
        return;
      }
      setCanvasMode(workspace, false);
    }
    activateItem(agentKey(tab.id));
  };

  const waiting = agents.filter((a) => a.state === "waiting").length;

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        className="cc-rise flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full shadow-lg
          bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10
          text-xs text-gray-700 dark:text-white/80 hover:bg-gray-50 dark:hover:bg-surface-overlay"
        title={t("background.expand")}
      >
        <span className="flex -space-x-1.5">
          {agents.slice(0, 4).map((a) => <AgentTile key={a.key} agent={a} size={24} ring />)}
        </span>
        {waiting > 0 && <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />}
        {t("background.count", { count: agents.length })}
      </button>
    );
  }

  return (
    <div
      className="cc-rise w-[300px] rounded-xl shadow-xl overflow-hidden
        bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10"
    >
      <div className="flex items-center gap-2 px-3 h-8 border-b border-gray-100 dark:border-white/8">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-white/45">
          {t("background.count", { count: agents.length })}
        </span>
        <button
          onClick={toggle}
          className="flex items-center justify-center w-6 h-6 rounded-md text-gray-400 dark:text-white/40
            hover:bg-gray-100 dark:hover:bg-white/8 hover:text-gray-800 dark:hover:text-white"
          title={t("background.collapse")}
          aria-label={t("background.collapse")}
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      <div className="py-1">
        {agents.slice(0, MAX_CARDS).map((agent) => (
          <button
            key={agent.key}
            onClick={() => open(agent)}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-white/5"
            style={agent.kind === "tab" ? { boxShadow: `inset 3px 0 0 ${agentPaint(agent.id).hex}` } : undefined}
          >
            <AgentTile agent={agent} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-gray-800 dark:text-white/90">{agent.title}</span>
              <span className="block truncate text-[11px] text-gray-500 dark:text-white/45">
                {agent.state === "waiting"
                  ? t("background.waiting")
                  : agent.detail ?? t(agent.kind === "task" ? "background.fleet" : "background.working")}
              </span>
            </span>
            {agent.state === "waiting" ? (
              <span className="shrink-0 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            ) : (
              <span className="shrink-0 w-3.5 h-3.5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
            )}
          </button>
        ))}
        {agents.length > MAX_CARDS && (
          <p className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-white/35">
            {t("background.more", { count: agents.length - MAX_CARDS })}
          </p>
        )}
      </div>
    </div>
  );
}

/** El logo del agente sobre el color de su marca, como el ícono de una app. */
function AgentTile({ agent, size, ring = false }: { agent: BackgroundAgent; size: number; ring?: boolean }) {
  const Icon = agentIcon(agent.agentId, agent.command);
  return (
    <span
      className={`shrink-0 flex items-center justify-center rounded-lg text-white shadow-sm ${ring ? "ring-2 ring-white dark:ring-surface-raised" : ""}`}
      style={{ width: size, height: size, background: agentTile(agent.agentId) }}
    >
      <Icon className="w-[55%] h-[55%]" />
    </span>
  );
}
