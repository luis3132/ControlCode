import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { AddIcon, EmptyState, NetworkIcon, SearchIcon, ShieldIcon, Tooltip } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { AppDialog } from "@/shared/ui/AppDialog";

import { AgentCard } from "./AgentCard";
import { countByGroup, filterFleet, FLEET_GROUPS, sortFleet, type FleetGroup } from "./fleetOrder";
import { NewTaskDialog } from "./NewTaskDialog";
import { RulesDialog } from "./RulesDialog";
import { useRunsStore } from "./store";
import type { PendingApproval, TaskEventPayload } from "./types";

/** Los eventos que emite el supervisor. Deben coincidir con `runs/supervisor.rs`. */
const TASK_EVENT = "cc-task-event";
const TASK_CHANGED = "cc-task-changed";
const APPROVALS_CHANGED = "cc-task-approvals";

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

  const tasks = useRunsStore((s) => s.tasks);
  const activity = useRunsStore((s) => s.activity);
  const loadTasks = useRunsStore((s) => s.loadTasks);
  const applyEvent = useRunsStore((s) => s.applyEvent);
  const refreshTask = useRunsStore((s) => s.refreshTask);
  const startTask = useRunsStore((s) => s.startTask);
  const cancelTask = useRunsStore((s) => s.cancelTask);
  const approvals = useRunsStore((s) => s.approvals);
  const setApprovals = useRunsStore((s) => s.setApprovals);
  const loadApprovals = useRunsStore((s) => s.loadApprovals);
  const decideApproval = useRunsStore((s) => s.decideApproval);

  const [group, setGroup] = useState<FleetGroup | null>(null);
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  // La carpeta donde se lanza: la de la tab activa, igual que el "+" de la barra de tabs.
  const cwd = tabs.find((tb) => tb.id === activeTabId)?.cwd ?? tabs[0]?.cwd ?? "";

  useEffect(() => {
    if (workspaceId) loadTasks(workspaceId).catch(console.error);
    // La cola no es por workspace: un permiso esperando es de la app entera. Se pide al
    // montar porque puede haber uno de antes de abrir esta pantalla.
    loadApprovals().catch(console.error);
  }, [workspaceId, loadTasks, loadApprovals]);

  useEffect(() => {
    if (!workspaceId) return;
    const unlisten = [
      listen<TaskEventPayload>(TASK_EVENT, (e) => applyEvent(e.payload)),
      listen<string>(TASK_CHANGED, (e) => refreshTask(workspaceId, e.payload)),
      listen<PendingApproval[]>(APPROVALS_CHANGED, (e) => setApprovals(e.payload)),
    ];
    return () => {
      unlisten.forEach((p) => p.then((off) => off()).catch(() => {}));
    };
  }, [workspaceId, applyEvent, refreshTask, setApprovals]);

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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("fleet.search")}
            className="w-40 bg-transparent outline-none text-[11.5px]
              text-gray-800 dark:text-gray-200
              placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
        </div>
      </div>

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
                approval={byTask.get(task.id)}
                focused={task.id === focusedId}
                onDecide={(allow, remember) => {
                  const a = byTask.get(task.id);
                  if (a) decideApproval(a.id, allow, remember).catch(console.error);
                }}
                onCancel={() => cancelTask(task.id).catch(console.error)}
                onShowResult={() => setDetail(task.id)}
                // El pane todavía no existe: llega en el corte 3, junto con el resto de la
                // consola. Mostrar el resultado es lo que hay hasta entonces, y decirlo es
                // mejor que un botón que no hace nada.
                onOpenPane={() => setDetail(task.id)}
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
          onClose={() => setNewOpen(false)}
          onStart={async (input) => {
            if (!workspaceId) throw new Error(t("fleet.error.noWorkspace"));
            await startTask({ ...input, workspaceId, cwd });
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
