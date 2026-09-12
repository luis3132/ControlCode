import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";

import { isLive } from "./fleetOrder";
import { PermissionCard } from "./PermissionCard";
import type { PendingApproval, Task, TaskStatus } from "./types";

/** Segundos transcurridos, refrescados solo mientras la tarea sigue viva. */
function useElapsed(task: Task): number {
  const live = isLive(task.status);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (!live) return;
    // Un intervalo por tarjeta viva. Con la flota entera terminada no queda ninguno
    // corriendo, que es lo que evita que la consola abierta en segundo plano despierte el
    // proceso una vez por segundo para siempre.
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [live]);

  const from = task.startedAt ?? task.createdAt;
  const to = live ? now : (task.endedAt ?? from);
  return Math.max(0, Math.floor(to - from));
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Miles con `k`, como lo escribe la propia TUI. */
function formatTokens(n: number): string {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `${n}`;
}

const BADGE: Record<TaskStatus, string> = {
  ready: "text-gray-500 dark:text-white/40 bg-gray-200/70 dark:bg-white/8",
  running: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12",
  done: "text-gray-500 dark:text-white/40 bg-gray-200/70 dark:bg-white/8",
  failed: "text-red-600 dark:text-red-400 bg-red-500/12",
  cancelled: "text-gray-500 dark:text-white/35 bg-gray-200/70 dark:bg-white/8",
};

/**
 * Una tarjeta de la flota: qué agente es, qué está haciendo y qué costó.
 *
 * Muestra actividad, no transcripción. Un agente headless emite eventos estructurados, así
 * que "qué archivo tocó" viene como dato: las líneas son ya la forma corta (`Bash(cargo
 * test)`), no un recorte de su salida. Quien quiera el detalle abre la tarea como pane.
 */
export function AgentCard({ task, activity, approval, focused, onCancel, onOpenPane, onShowResult, onDecide }: {
  task: Task;
  activity: string[];
  /** El permiso que esta tarea está esperando, si hay uno. */
  approval?: PendingApproval;
  /** Si es la tarjeta que responde a `y`/`n`. */
  focused: boolean;
  onCancel: () => void;
  onOpenPane: () => void;
  onShowResult: () => void;
  onDecide: (allow: boolean, remember: boolean) => void;
}) {
  const { t } = useTranslation();
  const Icon = agentIcon(task.agentId);
  const elapsed = useElapsed(task);
  const live = isLive(task.status);
  const tokens = (task.tokensIn ?? 0) + (task.tokensOut ?? 0);

  return (
    <div className={`flex flex-col rounded-xl overflow-hidden
      bg-gray-50 dark:bg-white/4
      border ${approval
        ? "border-amber-400/70 dark:border-amber-500/40"
        : task.status === "failed"
          ? "border-red-300/60 dark:border-red-500/25"
          : "border-gray-200 dark:border-white/10"}`}>

      {/* ── quién y en qué estado ── */}
      <div className="flex items-start gap-2.5 px-3 pt-2.5">
        <Icon className="w-[15px] h-[15px] mt-px shrink-0 text-gray-500 dark:text-white/50" />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0 font-mono text-[10px] text-gray-400 dark:text-white/30">
              {task.agentId}
            </span>
            <span className="truncate text-[12.5px] font-semibold text-gray-900 dark:text-white">
              {task.title}
            </span>
          </span>
          <span className="truncate font-mono text-[10px] text-gray-400 dark:text-white/30">
            {task.cwd}
          </span>
        </div>
        {/* Estar esperando una decisión gana sobre el estado: para quien mira, esta
            tarjeta no está trabajando, está parada por su culpa. */}
        <span className={`shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-bold
          uppercase tracking-wider ${approval
            ? "text-amber-800 dark:text-amber-300 bg-amber-500/20"
            : BADGE[task.status]}`}>
          {approval ? t("fleet.status.needsYou") : t(`fleet.status.${task.status}`)}
        </span>
      </div>

      {/* ── qué está haciendo ── */}
      <div className="flex flex-col gap-0.5 px-3 py-2.5 min-h-[4.5rem]">
        {activity.length === 0 && !task.error && (
          <span className="text-[11px] italic text-gray-400 dark:text-white/25">
            {live ? t("fleet.card.starting") : t("fleet.card.noActivity")}
          </span>
        )}
        {activity.map((line, i) => (
          <span
            key={`${i}-${line}`}
            className="truncate font-mono text-[10.5px] leading-relaxed
              text-gray-600 dark:text-white/55"
          >
            {line}
          </span>
        ))}
        {task.error && (
          <span className="line-clamp-2 font-mono text-[10.5px] leading-relaxed
            text-red-600 dark:text-red-400">
            {task.error}
          </span>
        )}
      </div>

      {approval && (
        <PermissionCard approval={approval} focused={focused} onDecide={onDecide} />
      )}

      {/* ── qué costó y qué se puede hacer ── */}
      <div className="flex items-center gap-2.5 px-3 h-8 shrink-0
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/15">
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={`w-1.5 h-1.5 rounded-full ${live
            ? "bg-emerald-500"
            : task.status === "failed" ? "bg-red-500" : "bg-gray-300 dark:bg-white/20"}`} />
          <span className="tabular-nums text-[10px] text-gray-500 dark:text-white/40">
            {formatElapsed(elapsed)}
          </span>
        </span>

        {tokens > 0 && (
          <span className="shrink-0 tabular-nums text-[10px] text-gray-400 dark:text-white/35">
            {formatTokens(tokens)}
          </span>
        )}
        {task.costUsd != null && (
          <span className="shrink-0 tabular-nums text-[10px] text-gray-400 dark:text-white/35">
            ${task.costUsd.toFixed(3)}
          </span>
        )}

        <div className="flex-1" />

        {live ? (
          <button onClick={onCancel} className={ACTION}>{t("fleet.card.stop")}</button>
        ) : (
          task.result && (
            <button onClick={onShowResult} className={ACTION}>{t("fleet.card.result")}</button>
          )
        )}
        {/* Abrir como pane es lo que una CLI no puede ofrecer: la app le impuso el id de
            sesión al lanzar, así que retoma ESA conversación en vez de empezar otra. */}
        <Tooltip content={t("fleet.card.openPaneHint")} placement="top">
          <button onClick={onOpenPane} disabled={!task.sessionId} className={ACTION}>
            {t("fleet.card.openPane")}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

const ACTION = `cc-t shrink-0 px-1.5 h-5 rounded text-[10px]
  text-gray-500 dark:text-white/45
  hover:text-gray-900 dark:hover:text-white
  hover:bg-gray-200 dark:hover:bg-white/10
  disabled:opacity-35 disabled:hover:bg-transparent`;
