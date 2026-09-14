import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fleetSummary } from "./fleetOrder";
import { useRunsStore } from "./store";

/**
 * La flota, en la barra de estado.
 *
 * Existe por el caso que la consola sola no cubre: estás en una terminal, un agente en
 * segundo plano pide permiso, y se queda parado sin que nada en la pantalla lo diga. Este
 * chip es lo que se ve desde cualquier lado, y el ámbar es lo que dice "te están
 * esperando".
 *
 * Desaparece si no hay nada que mostrar, igual que `OrchestratorIndicator`: un "0 agentes"
 * permanente es ruido para quien nunca usa la flota.
 */
export function FleetIndicator() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tasks = useRunsStore((s) => s.tasks);
  const approvals = useRunsStore((s) => s.approvals);
  const summary = useMemo(() => fleetSummary(tasks, approvals), [tasks, approvals]);

  if (summary.running === 0 && summary.needsYou === 0) return null;

  return (
    <>
      <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
      <button
        onClick={() => navigate("/fleet")}
        title={t("fleet.indicator.hint", { usd: summary.spentUsd.toFixed(3) })}
        className="cc-t flex items-center gap-2 px-1.5 h-[18px] rounded
          hover:bg-gray-200 dark:hover:bg-white/8"
      >
        {summary.needsYou > 0 && (
          <span className="flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            {t("fleet.indicator.needsYou", { n: summary.needsYou })}
          </span>
        )}
        {summary.running > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {t("fleet.indicator.running", { n: summary.running })}
          </span>
        )}
      </button>
    </>
  );
}
