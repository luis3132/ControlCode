import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AddIcon, ArchiveIcon, Badge, BoxIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon,
  TrashIcon, Tooltip,
} from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { BranchIcon, RunningIcon } from "@/app/icons";
import { elapsed } from "@/features/workspaces/useRepoInfo";
import type { RepoGroup, WorkspaceAgent, WorkspaceNode } from "@/features/workspaces/workspaceTree";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import { useSnapshotsStore } from "@/features/workspaces/snapshotsStore";
import { useSkillsStore } from "@/features/skills/store";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { flushPendingSave } from "@/features/tabs/persistence";

function AgentRow({ agent, onClick, onContextMenu }: {
  agent: WorkspaceAgent;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const Icon = agentIcon(agent.agentId, agent.agentLabel);
  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e); }}
      title={agent.title}
      className={`flex items-center gap-2 h-[25px] pl-1.5 pr-1 rounded-md w-full text-left
        transition-colors duration-150
        ${agent.isActive
          ? "bg-blue-500/12 dark:bg-blue-400/13"
          : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}
    >
      <RunningIcon
        className={`w-3.5 h-3.5 shrink-0 ${
          agent.status === "running" ? "text-emerald-500" : "text-amber-500"}`}
      />
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 rounded
        text-gray-500 dark:text-gray-400">
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className={`flex-1 min-w-0 truncate text-[11px]
        ${agent.isActive
          ? "text-gray-900 dark:text-blue-100"
          : "text-gray-600 dark:text-gray-400"}`}>
        {agent.title}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
        {elapsed(agent.openedAt)}
      </span>
    </button>
  );
}

function WorkspaceCard({ ws, onOpenAgent, onWorkspaceMenu, onAgentMenu }: {
  ws: WorkspaceNode;
  onOpenAgent: (id: string) => void;
  onWorkspaceMenu: (e: React.MouseEvent, ws: WorkspaceNode) => void;
  onAgentMenu: (e: React.MouseEvent, agent: WorkspaceAgent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); onWorkspaceMenu(e, ws); }}
      className="mx-2 my-0.5 px-1.5 pt-1.5 pb-1 rounded-[10px] flex flex-col gap-1
      bg-gray-200/50 dark:bg-white/5
      border border-gray-200 dark:border-white/10"
    >

      <div className="flex items-center gap-1.5 px-0.5">
        <BranchIcon className="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-gray-900 dark:text-white">
          {ws.title}
        </span>
        {ws.isPrimary && (
          <Badge variant="outline" size="sm" className="shrink-0">
            {t("workspaces.primary")}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2 pl-[21px] pr-0.5">
        <span className="flex-1 min-w-0 truncate font-mono text-[10px] text-gray-400 dark:text-white/35">
          {ws.subtitle}
        </span>
        {ws.changedCount > 0 && (
          <span className="shrink-0 font-mono text-[9.5px] text-amber-600 dark:text-amber-400">
            {t("workspaces.changed", { n: ws.changedCount })}
          </span>
        )}
      </div>

      <div className="pl-[21px] text-[10px] text-gray-400 dark:text-white/35">
        {t("workspaces.agentCount", { n: ws.agents.length })}
      </div>

      <div className="flex flex-col gap-px">
        {ws.agents.map((a) => (
          <AgentRow
            key={a.tabId}
            agent={a}
            onClick={() => onOpenAgent(a.tabId)}
            onContextMenu={(e) => onAgentMenu(e, a)}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspaceRow({ ws, onClick, onContextMenu }: {
  ws: WorkspaceNode;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const running = ws.agents.some((a) => a.status === "running");
  return (
    <button
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e); }}
      className="flex items-center gap-2.5 mx-2 px-2 py-1.5 rounded-lg w-[calc(100%-1rem)] text-left
        hover:bg-gray-200/60 dark:hover:bg-white/5 transition-colors duration-150"
    >
      {ws.closed ? (
        <ArchiveIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/25" />
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0
          ${running ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/20"}`} />
      )}
      <span className="flex flex-col gap-px min-w-0 flex-1">
        <span className={`truncate text-[11.5px]
          ${ws.closed ? "text-gray-400 dark:text-white/35" : "text-gray-700 dark:text-gray-300"}`}>
          {ws.title}
        </span>
        <span className="truncate font-mono text-[10px] text-gray-400 dark:text-white/30">
          {ws.closed ? t("workspaces.saved", { n: ws.savedAgents }) : ws.subtitle}
        </span>
      </span>
      {!ws.closed && (
        <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
          {ws.agents.length}
        </span>
      )}
    </button>
  );
}

/**
 * El panel de la izquierda: repos → workspaces → agentes.
 *
 * Un workspace es una carpeta de trabajo con agentes adentro (el checkout principal,
 * marcado PRIMARY, o un worktree). Reemplaza al modelo de "un workspace = varias
 * ventanas": acá se cambia de workspace en el lugar, sin abrir nada.
 */
export function WorkspacesPanel({ groups, width }: { groups: RepoGroup[]; width: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activateTab = useTabsStore((s) => s.activateTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<
    { x: number; y: number; ws: WorkspaceNode | null; target: SkillScopeTarget } | null
  >(null);
  const [skillTarget, setSkillTarget] = useState<SkillScopeTarget | null>(null);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const closeTab = useTabsStore((s) => s.closeTab);
  const tabs = useTabsStore((s) => s.tabs);
  const addTab = useTabsStore((s) => s.addTab);
  const skills = useSkillsStore((s) => s.skills);
  const saveSnapshot = useSnapshotsStore((s) => s.save);
  const takeSnapshot = useSnapshotsStore((s) => s.take);
  const forgetSnapshot = useSnapshotsStore((s) => s.forget);

  const running = useMemo(
    () => groups.flatMap((g) => g.workspaces).flatMap((w) => w.agents).filter((a) => a.status === "running").length,
    [groups]
  );
  const starting = useMemo(
    () => groups.flatMap((g) => g.workspaces).flatMap((w) => w.agents).length - running,
    [groups, running]
  );

  const openAgent = (tabId: string) => {
    activateTab(tabId);
    navigate("/workspace");
  };

  // Click derecho sobre el WORKSPACE: sus skills valen para todos los agentes que se
  // abran en esa carpeta. Sobre un AGENTE: solo para ese.
  const onWorkspaceMenu = (e: React.MouseEvent, ws: WorkspaceNode) =>
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ws,
      target: { scope: "workspace", workspaceId, cwd: ws.cwd, agentId: null, label: ws.title },
    });

  const onAgentMenu = (e: React.MouseEvent, agent: WorkspaceAgent) =>
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ws: null,
      target: {
        scope: "tab",
        workspaceId,
        tabId: agent.tabId,
        agentId: agent.agentId,
        label: agent.title,
      },
    });

  /**
   * Cerrar un workspace entero: se guarda lo que tenía y recién después se cierran sus
   * tabs. En ese orden, porque cerrar una tab se lleva puesto lo que hay que recordar —
   * su sesión y, por cascada en la base, las skills que tenía adjuntas.
   */
  const closeWorkspace = async (ws: WorkspaceNode) => {
    const mine = tabs.filter((tab) => tab.cwd === ws.cwd);
    if (mine.length === 0) return;

    await saveSnapshot(ws.cwd, workspaceId, mine.map((tab) => ({
      title: tab.title,
      titleIsCustom: tab.titleIsCustom ?? null,
      agentId: tab.agentId,
      agentLabel: tab.agentLabel,
      command: tab.command,
      sessionId: tab.sessionId ?? null,
      accountId: tab.accountId ?? null,
      prelaunch: tab.prelaunch ?? [],
      skillIds: skills
        .filter((s) => s.usedBy.some((u) => u.scope === "tab" && u.tabId === tab.id))
        .map((s) => s.id),
    })));

    for (const tab of mine) closeTab(tab.id);
  };

  /** Reabrirlo: se recrean sus agentes con su conversación y sus skills. */
  const reopenWorkspace = async (ws: WorkspaceNode) => {
    const snapshot = await takeSnapshot(ws.cwd);
    if (!snapshot) return;

    let first: string | null = null;
    for (const saved of snapshot.tabs) {
      const tabId = addTab({
        cwd: snapshot.cwd,
        agent: {
          id: saved.agentId,
          label: saved.agentLabel,
          command: saved.command,
          available: true,
        },
        title: saved.title,
        titleIsCustom: saved.titleIsCustom ?? undefined,
        sessionId: saved.sessionId ?? undefined,
        accountId: saved.accountId ?? undefined,
        prelaunch: saved.prelaunch,
      });
      first ??= tabId;

      if (saved.skillIds.length > 0) {
        // Los symlinks tienen que existir ANTES de que arranque el agente: varias TUIs
        // solo leen su carpeta de skills al boot. `flushPendingSave` va adentro de
        // `attachSkillsToTab`, que es lo que hace que la fila de la tab exista en SQLite.
        registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, saved.skillIds));
      }
    }

    if (first) {
      await flushPendingSave();
      activateTab(first);
      navigate("/workspace");
    }
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  return (
    <aside
      style={{ width }}
      className="cc-fade flex flex-col shrink-0 min-h-0
        bg-gray-50 dark:bg-[#0a0f16]
        border-r border-gray-200 dark:border-white/7"
    >
      <div className="flex items-center gap-2 h-8 shrink-0 pl-3 pr-1.5
        border-b border-gray-200 dark:border-white/7">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.09em]
          text-gray-500 dark:text-gray-400">
          {t("rail.workspaces")}
        </span>
        <div className="flex-1" />
        {(running > 0 || starting > 0) && (
          <span className="flex items-center gap-2 text-[10px] tabular-nums
            text-gray-400 dark:text-white/35">
            {running > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{running}
              </span>
            )}
            {starting > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{starting}
              </span>
            )}
          </span>
        )}
        <Tooltip content={t("workspaces.new")} placement="bottom">
          <button
            onClick={() => navigate("/")}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <AddIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed
            text-gray-400 dark:text-white/30">
            {t("workspaces.empty")}
          </p>
        ) : (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key} className="mt-1.5 first:mt-0">
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center gap-2 h-7 w-full px-3 text-left
                    hover:bg-gray-200/50 dark:hover:bg-white/4 transition-colors"
                >
                  {collapsed
                    ? <ChevronRightIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/35" />
                    : <ChevronDownIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/35" />}
                  <span className="flex-1 min-w-0 truncate text-[11.5px] font-semibold
                    text-gray-700 dark:text-gray-300">
                    {group.name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
                    {group.workspaces.length}
                  </span>
                </button>

                {!collapsed && group.workspaces.map((ws) => {
                  const hasActive = ws.agents.some((a) => a.tabId === activeTabId);
                  return hasActive
                    ? <WorkspaceCard
                        key={ws.key}
                        ws={ws}
                        onOpenAgent={openAgent}
                        onWorkspaceMenu={onWorkspaceMenu}
                        onAgentMenu={onAgentMenu}
                      />
                    : <WorkspaceRow
                        key={ws.key}
                        ws={ws}
                        onClick={() => (ws.closed
                          ? reopenWorkspace(ws).catch(console.error)
                          : openAgent(ws.agents[0].tabId))}
                        onContextMenu={(e) => onWorkspaceMenu(e, ws)}
                      />;
                })}
              </div>
            );
          })
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: "skills",
              label: t(menu.target.scope === "tab" ? "skills.scope.tabAction" : "skills.scope.workspaceAction"),
              icon: <BoxIcon className="w-4 h-4" />,
              onSelect: () => setSkillTarget(menu.target),
            },
            ...(menu.target.scope === "tab" && menu.target.tabId
              ? [{
                  key: "close",
                  label: t("tabs.close"),
                  icon: <CloseIcon className="w-4 h-4" />,
                  danger: true,
                  onSelect: () => closeTab(menu.target.tabId!),
                }]
              : []),
            // Sobre un workspace CERRADO no hay nada que cerrar: lo que se puede es
            // olvidarlo, que es lo único destructivo de verdad acá.
            ...(menu.ws && !menu.ws.closed
              ? [{
                  key: "close-ws",
                  label: t("workspaces.close"),
                  icon: <CloseIcon className="w-4 h-4" />,
                  danger: true,
                  onSelect: () => { closeWorkspace(menu.ws!).catch(console.error); },
                }]
              : []),
            ...(menu.ws?.closed
              ? [{
                  key: "forget-ws",
                  label: t("workspaces.forget"),
                  icon: <TrashIcon className="w-4 h-4" />,
                  danger: true,
                  onSelect: () => { forgetSnapshot(menu.ws!.cwd).catch(console.error); },
                }]
              : []),
          ]}
        />
      )}

      {skillTarget && (
        <SkillPalette target={skillTarget} onClose={() => setSkillTarget(null)} />
      )}
    </aside>
  );
}
