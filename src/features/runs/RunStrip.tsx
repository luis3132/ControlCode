import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { CloseIcon, Tooltip } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import type { RunSummary } from "./fleetOrder";
import { listFacts } from "./ipc";
import type { Fact } from "./types";

const DOT: Record<string, string> = {
  running: "bg-emerald-500",
  done: "bg-gray-400 dark:bg-white/30",
  failed: "bg-red-500",
  cancelled: "bg-gray-300 dark:bg-white/20",
};

/**
 * Los runs orquestados del workspace: un objetivo que un lead repartió en tareas. Cada uno
 * se ve de un vistazo —cuántas listas, cuántas en curso, cuántas no se van a cumplir— y al
 * elegirlo la consola muestra solo sus tarjetas.
 */
export function RunStrip({ summaries, selected, onSelect, onCancel }: {
  summaries: RunSummary[];
  selected: string | null;
  onSelect: (runId: string | null) => void;
  onCancel: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const [factsOf, setFactsOf] = useState<string | null>(null);
  const current = summaries.find((s) => s.run.id === selected) ?? null;

  return (
    <div className="shrink-0 border-b border-gray-200 dark:border-white/8">
      <div className="flex items-center gap-2 h-11 px-4 overflow-x-auto">
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-white/30">
          {t("fleet.runs.title")}
        </span>
        {summaries.map((s) => {
          const on = s.run.id === selected;
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
          return (
            <button
              key={s.run.id}
              onClick={() => onSelect(on ? null : s.run.id)}
              aria-pressed={on}
              title={s.run.objective}
              className={`cc-t shrink-0 flex items-center gap-2 max-w-[18rem] h-7 pl-2 pr-2.5 rounded-lg border text-[11px]
                ${on
                  ? "border-blue-400/60 bg-blue-500/10 text-blue-800 dark:text-blue-200"
                  : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/55 hover:bg-gray-100 dark:hover:bg-white/5"}`}
            >
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${DOT[s.run.status] ?? DOT.done}`} />
              <span className="truncate">{s.run.objective}</span>
              <span className="shrink-0 tabular-nums opacity-70">
                {s.total > 0 ? `${s.done}/${s.total}` : t("fleet.runs.planning")}
              </span>
              {s.total > 0 && (
                <span className="shrink-0 w-10 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                  <span className={`block h-full ${s.broken > 0 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {current && (
        <div className="flex items-center gap-3 min-h-9 px-4 py-1.5 text-[11px]
          bg-blue-50/60 dark:bg-blue-500/5 border-t border-blue-100 dark:border-blue-500/10">
          <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-gray-600 dark:text-white/55">
            <span className="tabular-nums">{t("fleet.runs.progress", { done: current.done, total: current.total })}</span>
            {current.active > 0 && <span className="tabular-nums">{t("fleet.runs.active", { n: current.active })}</span>}
            {current.broken > 0 && (
              <span className="tabular-nums text-amber-700 dark:text-amber-400">{t("fleet.runs.broken", { n: current.broken })}</span>
            )}
            <span className="tabular-nums">
              {current.run.budgetUsd
                ? t("fleet.runs.spentOf", { usd: current.run.spentUsd.toFixed(2), budget: current.run.budgetUsd.toFixed(2) })
                : t("fleet.runs.spent", { usd: current.run.spentUsd.toFixed(2) })}
            </span>
            <span>{t("fleet.runs.parallel", { n: current.run.maxParallel })}</span>
          </span>
          <button onClick={() => setFactsOf(current.run.id)} className={ACTION}>{t("fleet.runs.facts")}</button>
          {current.run.status === "running" && (
            <Tooltip content={t("fleet.runs.cancelHint")} placement="bottom">
              <button onClick={() => onCancel(current.run.id)} className={`${ACTION} text-red-600 dark:text-red-400`}>
                {t("fleet.runs.cancel")}
              </button>
            </Tooltip>
          )}
          <button onClick={() => onSelect(null)} aria-label={t("fleet.runs.all")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <CloseIcon className="w-3 h-3" />
          </button>
        </div>
      )}

      {factsOf && <FactsDialog runId={factsOf} onClose={() => setFactsOf(null)} />}
    </div>
  );
}

/** Lo que se dejaron escrito los agentes del run, con su autor. */
function FactsDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => listFacts(runId).then(setFacts).catch((e) => setError(String(e)));
    load();
    // Evento de `runs/orchestration.rs`: un agente acaba de escribir un hecho.
    const off = listen<string>("cc-run-facts", (e) => { if (e.payload === runId) load(); });
    return () => { off.then((f) => f()).catch(() => {}); };
  }, [runId]);

  return (
    <AppDialog title={t("fleet.runs.factsTitle")} size="md" closeOnEsc onClose={onClose}>
      <div className="flex flex-col gap-2">
        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{t("fleet.runs.factsHint")}</p>
        {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
        {facts?.length === 0 && (
          <p className="py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">{t("fleet.runs.factsEmpty")}</p>
        )}
        {facts?.map((f) => (
          <div key={f.id} className="flex flex-col gap-0.5 px-2.5 py-2 rounded-lg bg-gray-100/70 dark:bg-white/4 border border-gray-200/70 dark:border-white/8">
            <span className="flex items-center gap-2 text-[10px]">
              <span className="px-1.5 rounded font-semibold uppercase tracking-wider bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-white/60">
                {t(`fleet.runs.kind.${f.kind}`)}
              </span>
              <span className="truncate text-gray-400 dark:text-white/35">{f.author ?? t("fleet.runs.authorUser")}</span>
              <span className="ml-auto shrink-0 tabular-nums text-gray-400 dark:text-white/30">
                {new Date(f.createdAt * 1000).toLocaleTimeString()}
              </span>
            </span>
            <span className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-800 dark:text-gray-200">{f.body}</span>
          </div>
        ))}
      </div>
    </AppDialog>
  );
}

const ACTION = `cc-t shrink-0 px-2 h-6 rounded-md text-[11px] font-medium
  text-gray-600 dark:text-white/55 hover:bg-gray-200 dark:hover:bg-white/10`;
