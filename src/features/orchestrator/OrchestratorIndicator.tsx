import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { orchestratorStats, resetOrchestratorUsage, type OrchestratorStats } from "./ipc";

/** A partir de acá el chip avisa en ámbar: el orquestador ya lleva consumido más contexto
 *  del que le queda cómodo a una conversación típica. */
const TOKENS_WARNING = 100_000;

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Indicador de consumo del modo orquestador (Fase 9).
 *
 * Solo aparece cuando la CLI ya pidió algo: mientras nadie orqueste, no ocupa lugar en la
 * barra. La razón de existir es que el costo de este modo es invisible — se paga en el
 * contexto de un modelo que corre en OTRA terminal, así que sin este número el usuario se
 * entera recién cuando el agente empieza a olvidarse de cosas.
 *
 * El total es una estimación (~4 caracteres por token) sobre los bytes que la CLI se
 * llevó; sirve para el orden de magnitud, no para facturar.
 */
export function OrchestratorIndicator() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<OrchestratorStats | null>(null);

  useEffect(() => {
    let stale = false;

    orchestratorStats()
      .then((s) => { if (!stale) setStats(s); })
      .catch(() => { /* sin backend de orquestador el chip simplemente no aparece */ });

    const unlisten = listen<OrchestratorStats>("cc-orchestrator-stats", (e) => {
      if (stale) return;
      // El emisor del evento no siempre tiene la conexión a SQLite a mano y manda 0 como
      // "no lo sé"; el límite real lo trajo la lectura inicial.
      setStats((prev) => ({
        ...e.payload,
        watchLimit: e.payload.watchLimit || prev?.watchLimit || 0,
      }));
    });

    return () => {
      stale = true;
      unlisten.then((off) => off());
    };
  }, []);

  if (!stats || stats.requests === 0) return null;

  const atLimit = stats.watchLimit > 0 && stats.watched >= stats.watchLimit;
  const heavy = stats.estimatedTokens >= TOKENS_WARNING;
  const alert = atLimit || heavy;

  const tooltip = [
    // `requests` y no `count`: pasar `count` haría que i18next intente resolver plurales
    // y busque una clave `_one`/`_other` que este proyecto no declara para nada.
    t("orchestrator.tooltip.requests", { requests: stats.requests }),
    t("orchestrator.tooltip.tokens", { tokens: stats.estimatedTokens.toLocaleString() }),
    stats.watchLimit > 0
      ? t("orchestrator.tooltip.watched", { watched: stats.watched, limit: stats.watchLimit })
      : null,
    stats.lastCommand ? t("orchestrator.tooltip.last", { command: stats.lastCommand }) : null,
    t("orchestrator.tooltip.reset"),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      title={tooltip}
      onClick={() => resetOrchestratorUsage().catch(console.error)}
      className={`flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] font-medium
        border transition-colors duration-150 shrink-0
        ${alert
          ? "border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
          : "border-gray-200 dark:border-white/10 bg-gray-100/70 dark:bg-white/5 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
        <path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />
      </svg>
      {stats.watched > 0 && (
        <span className="tabular-nums">
          {stats.watched}
          {stats.watchLimit > 0 && `/${stats.watchLimit}`}
        </span>
      )}
      <span className="tabular-nums">~{formatTokens(stats.estimatedTokens)}</span>
    </button>
  );
}
