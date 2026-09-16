import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AddIcon, EmptyState, Kbd, NetworkIcon, SearchIcon, ShieldIcon, Tooltip } from "neogestify-ui-components";

import { detectAgents } from "@/features/agents/ipc";

import { useTabsStore } from "@/features/tabs/store";
import { AppDialog } from "@/shared/ui/AppDialog";

import { AgentCard } from "./AgentCard";
import {
  countByGroup, filterFleet, FLEET_GROUPS, liveInFolder, orchestratedRuns, sortFleet, waitingOn, type FleetGroup,
} from "./fleetOrder";
import { NewTaskDialog } from "./NewTaskDialog";
import { RunStrip } from "./RunStrip";
import { RulesDialog } from "./RulesDialog";
import { useRunsStore } from "./store";
import type { PendingApproval, Task } from "./types";

/**
 * La consola de flota: qué está haciendo cada agente headless, todo junto.
 *
 * Es la pantalla que hace útil correr varios agentes a la vez. Sin ella, cinco agentes son
 * cinco cosas que hay que ir a mirar de a una — y el que se quedó esperando algo no se
 * distingue del que está trabajando.
 */
export function FleetPage() {
  const { t } = useTranslation();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  const allTasks = useRunsStore((s) => s.tasks);
  const runs = useRunsStore((s) => s.runs);
  const activity = useRunsStore((s) => s.activity);
  const startTask = useRunsStore((s) => s.startTask);
  const startOrchestration = useRunsStore((s) => s.startOrchestration);
  const cancelRun = useRunsStore((s) => s.cancelRun);
  const cancelTask = useRunsStore((s) => s.cancelTask);
  const approvals = useRunsStore((s) => s.approvals);
  const decideApproval = useRunsStore((s) => s.decideApproval);
  const handOffTask = useRunsStore((s) => s.handOffTask);
  const rerouteTask = useRunsStore((s) => s.rerouteTask);
  const discardWorktree = useRunsStore((s) => s.discardWorktree);

  const [group, setGroup] = useState<FleetGroup | null>(null);
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  /** El run al que se está mirando. `null` = toda la flota. */
  const [runFilter, setRunFilter] = useState<string | null>(null);
  const summaries = useMemo(() => orchestratedRuns(runs, allTasks), [runs, allTasks]);
  // Un run que desapareció (se borró) no puede seguir filtrando: la consola quedaría vacía
  // sin decir por qué.
  const activeRun = runFilter ? summaries.find((s) => s.run.id === runFilter) ?? null : null;
  const tasks = useMemo(
    () => (activeRun ? allTasks.filter((tk) => tk.runId === activeRun.run.id) : allTasks),
    [allTasks, activeRun]
  );

  // La carpeta donde se lanza: la de la tab activa, igual que el "+" de la barra de tabs.
  const cwd = tabs.find((tb) => tb.id === activeTabId)?.cwd ?? tabs[0]?.cwd ?? "";

  // Los eventos los escucha `useFleetEvents` desde el shell, esté abierta o no esta
  // pantalla. Acá solo se lee.

  const addTab = useTabsStore((s) => s.addTab);
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  /** Un aviso sobre la última acción de una tarjeta: tomar el control, descartar. */
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  // `/` enfoca el buscador. No Ctrl+K, que es lo que muestra el mockup: acá Ctrl+K ya es
  // Skills, y robarlo rompería un atajo que la gente ya tiene en los dedos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Sigue la conversación de una tarea en una terminal de verdad. */
  const openInTerminal = async (task: Task) => {
    setNotice(null);
    try {
      const ready = await handOffTask(task.id);
      if (!ready.sessionId) return;
      const agent = (await detectAgents()).find((a) => a.id === ready.agentId);
      addTab({
        cwd: ready.cwd,
        agent: agent ?? { id: ready.agentId, label: ready.agentId, command: ready.agentId, available: true },
        title: ready.title,
        // La sesión que la app le impuso al lanzar: la tab retoma ESA conversación con
        // `--resume` en vez de empezar otra.
        sessionId: ready.sessionId,
        // Y con la misma cuenta: el transcript vive dentro de la carpeta de la cuenta, y
        // con otra el resume no lo encontraría.
        accountId: ready.accountId ?? undefined,
      });
      navigate("/workspace");
    } catch (e) {
      setNotice({ error: true, text: String(e) });
    }
  };

  /** Descarta el worktree de una tarea terminada, y dice qué pasó con su rama. */
  const discard = async (task: Task) => {
    setNotice(null);
    try {
      const done = await discardWorktree(task.id);
      // Que la rama quede es la parte que importa contar: ahí está el trabajo del agente, y
      // sin decirlo el usuario creería que se fue con la carpeta.
      setNotice({
        error: false,
        text: done.branchKept
          ? t("fleet.worktree.discardedKept", { branch: done.branch })
          : t("fleet.worktree.discarded", { branch: done.branch }),
      });
    } catch (e) {
      setNotice({ error: true, text: String(e) });
    }
  };

  // Por tarea, el primer permiso que esté esperando. Puede haber más de uno encolado si el
  // agente pidió varias cosas seguidas; se muestra de a uno para que la decisión sea sobre
  // algo concreto y no sobre una lista.
  const byTask = useMemo(() => {
    const map = new Map<string, PendingApproval>();
    for (const a of approvals) if (!map.has(a.taskId)) map.set(a.taskId, a);
    return map;
  }, [approvals]);
  const blocked = useMemo(() => new Set(byTask.keys()), [byTask]);

  const counts = useMemo(() => countByGroup(tasks, blocked), [tasks, blocked]);
  const shown = useMemo(
    () => sortFleet(filterFleet(tasks, group, query, blocked), blocked),
    [tasks, group, query, blocked]
  );
  const detailTask = tasks.find((tk) => tk.id === detail);
  // El teclado contesta la PRIMERA tarjeta trabada del orden vigente, que es la que el
  // usuario tiene arriba de todo. Con varias, `y` a secas sería ambiguo.
  const focusedId = shown.find((tk) => blocked.has(tk.id))?.id;

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ══ franja: filtros y buscador ══════════════════════════════ */}
      <div className="flex items-center gap-2 h-[54px] shrink-0 pl-4 pr-14
        border-b border-gray-200 dark:border-white/8">
        <NetworkIcon className="w-[15px] h-[15px] shrink-0 text-emerald-500 dark:text-emerald-400" />
        <span className="shrink-0 text-[13.5px] font-bold text-gray-900 dark:text-white">
          {t("fleet.title")}
        </span>

        <div className="flex items-center gap-1 ml-2">
          {FLEET_GROUPS.map((g) => (
            <button
              key={g}
              onClick={() => setGroup(group === g ? null : g)}
              disabled={counts[g] === 0}
              className={`cc-t flex items-center gap-1.5 px-2 h-6 rounded-full text-[10.5px]
                disabled:opacity-30
                ${group === g
                  ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                  : "text-gray-500 dark:text-white/45 hover:bg-gray-200 dark:hover:bg-white/8"}`}
            >
              {t(`fleet.group.${g}`)}
              <span className="tabular-nums opacity-70">{counts[g]}</span>
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Las reglas son de la carpeta en la que se lanza, la misma que usa "Nuevo agente". */}
        <Tooltip content={t("fleet.rules.title")} placement="bottom">
          <button
            onClick={() => setRulesOpen(true)}
            disabled={!cwd}
            aria-label={t("fleet.rules.title")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10
              disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ShieldIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>

        <div className="flex items-center gap-1.5 px-2 h-7 rounded-lg shrink-0
          bg-gray-100 dark:bg-white/5
          border border-gray-200 dark:border-white/10">
          <SearchIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/30" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
            }}
            placeholder={t("fleet.search")}
            className="w-40 bg-transparent outline-none text-[11.5px]
              text-gray-800 dark:text-gray-200
              placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
          <Kbd>/</Kbd>
        </div>
      </div>

      {notice && (
        <div className={`shrink-0 px-4 py-2 text-[11px] border-b
          ${notice.error
            ? "text-red-600 dark:text-red-400 border-red-200/60 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8"
            : "text-violet-700 dark:text-violet-300 border-violet-200/60 dark:border-violet-500/20 bg-violet-50 dark:bg-violet-500/8"}`}>
          {notice.text}
        </div>
      )}

      {summaries.length > 0 && (
        <RunStrip
          summaries={summaries}
          selected={activeRun?.run.id ?? null}
          onSelect={setRunFilter}
          onCancel={(runId) => {
            if (!workspaceId) return;
            cancelRun(workspaceId, runId).catch((e) => setNotice({ error: true, text: String(e) }));
          }}
        />
      )}

      {/* ══ la grilla ═══════════════════════════════════════════════ */}
      <div className="flex-1 min-h-0 cc-scroll p-3">
        {tasks.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={<NetworkIcon className="w-8 h-8" />}
            title={t("fleet.empty.title")}
            description={t("fleet.empty.desc")}
          />
        ) : (
          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
            {shown.map((task) => (
              <AgentCard
                key={task.id}
                task={task}
                activity={activity[task.id] ?? []}
                waiting={task.status === "pending" ? waitingOn(task, allTasks) : undefined}
                approval={byTask.get(task.id)}
                focused={task.id === focusedId}
                onDecide={(allow, remember) => {
                  const a = byTask.get(task.id);
                  if (a) decideApproval(a.id, allow, remember).catch(console.error);
                }}
                onCancel={() => cancelTask(task.id).catch(console.error)}
                onShowResult={() => setDetail(task.id)}
                onOpenPane={() => openInTerminal(task)}
                onDiscardWorktree={() => discard(task)}
                onReroute={() => rerouteTask(task.id).catch(console.error)}
              />
            ))}

            <button
              onClick={() => setNewOpen(true)}
              disabled={!cwd}
              className="cc-t flex flex-col items-center justify-center gap-1 min-h-[10rem]
                rounded-xl border border-dashed
                border-gray-300 dark:border-white/15
                text-gray-400 dark:text-white/30
                hover:border-gray-400 dark:hover:border-white/30
                hover:text-gray-600 dark:hover:text-white/50
                disabled:opacity-40"
            >
              <AddIcon className="w-5 h-5" />
              <span className="text-[11.5px]">{t("fleet.new.card")}</span>
            </button>
          </div>
        )}
      </div>

      {/* ══ pie ═════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20
        text-[10.5px] text-gray-400 dark:text-white/35">
        <span className="tabular-nums shrink-0">{t("fleet.count", { n: tasks.length })}</span>
        <span className="tabular-nums shrink-0">
          {t("fleet.spent", { usd: totalCost(tasks).toFixed(3) })}
        </span>
        <span className="flex-1 truncate">{t("fleet.sortedHint")}</span>
      </div>

      {newOpen && cwd && (
        <NewTaskDialog
          cwd={cwd}
          busyInFolder={liveInFolder(tasks, cwd)}
          onClose={() => setNewOpen(false)}
          onStart={async ({ kind, ...input }) => {
            if (!workspaceId) throw new Error(t("fleet.error.noWorkspace"));
            if (kind === "orchestrate" && "objective" in input) {
              const lead = await startOrchestration({ ...input, workspaceId, cwd });
              // Se abre mirando ese run: es lo que se acaba de pedir.
              setRunFilter(lead.runId);
            } else if ("prompt" in input) {
              await startTask({ ...input, workspaceId, cwd });
            }
          }}
        />
      )}

      {detailTask && <TaskDetail task={detailTask} onClose={() => setDetail(null)} />}
      {rulesOpen && cwd && <RulesDialog cwd={cwd} onClose={() => setRulesOpen(false)} />}
    </div>
  );
}

function totalCost(tasks: { costUsd: number | null }[]): number {
  return tasks.reduce((sum, tk) => sum + (tk.costUsd ?? 0), 0);
}

/** Lo que el agente entregó, entero. La tarjeta solo muestra actividad. */
function TaskDetail({ task, onClose }: {
  task: { title: string; result: string | null; error: string | null; prompt: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog title={task.title} size="lg" closeOnEsc onClose={onClose}>
      <div className="flex flex-col gap-3">
        <section className="flex flex-col gap-1">
          <h3 className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
            {t("fleet.detail.prompt")}
          </h3>
          <p className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed
            text-gray-500 dark:text-white/45">
            {task.prompt}
          </p>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
            {task.error ? t("fleet.detail.error") : t("fleet.detail.result")}
          </h3>
          <p className={`whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed
            ${task.error
              ? "text-red-600 dark:text-red-400"
              : "text-gray-800 dark:text-gray-200"}`}>
            {task.error ?? task.result ?? t("fleet.detail.nothing")}
          </p>
        </section>
      </div>
    </AppDialog>
  );
}
