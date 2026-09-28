import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Progress } from "neogestify-ui-components";
import { RefreshIcon } from "@/app/icons";

import { agentIcon } from "@/features/agents/agentIcons";
import {
  agentAccountUsage, claudeLiveUsage, formatAgo, isUsageFresh, planLabel,
  type AccountUsage, type LiveUsage,
} from "./usage";
import { accountEnv } from "./ipc";
import type { AgentAccount } from "./types";

/** Un perfil sintético (`system:*`) no tiene fila en la base: para el backend es `null`. */
function realAccountId(account: AgentAccount): string | null {
  return account.id.startsWith("system:") ? null : account.id;
}

/**
 * La cuota del plan de una cuenta: cuánto queda de la ventana actual y de la semana, tal
 * como lo informa la TUI. Solo eso — los tokens de los transcripts son consumo, no cuota,
 * y al lado de las barras se confundían con ella.
 */
export function AccountUsagePopover({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [live, setLive] = useState<LiveUsage | null>(null);
  /** Sin nada que mostrar todavía. */
  const [asking, setAsking] = useState(false);
  /** Hay un dato en pantalla y se está pidiendo uno nuevo por detrás. */
  const [refreshing, setRefreshing] = useState(false);
  /** Sube al apretar refrescar: obliga a preguntar de nuevo en vez de releer la caché. */
  const [reload, setReload] = useState(0);
  const Icon = agentIcon(account.agentId, account.agentId);

  useEffect(() => {
    let stale = false;
    setUsage(null);
    // Solo por el plan (el distintivo de arriba).
    agentAccountUsage(account.agentId, realAccountId(account))
      .then((u) => { if (!stale) setUsage(u); })
      .catch(() => {});
    return () => { stale = true; };
  }, [account]);

  // El cupo del plan no está en ningún archivo: hay que preguntárselo a la TUI, y eso
  // cuesta levantarla entera. Así que primero se muestra lo último guardado —que sobrevive
  // al cierre de la app— y recién después, si venció o si lo pidió el usuario, se vuelve a
  // preguntar. El panel nunca queda en blanco esperando.
  useEffect(() => {
    if (account.agentId !== "claude-code") return;
    let stale = false;

    const ask = async (force: boolean) => {
      const env = realAccountId(account) ? await accountEnv(account.id) : {};
      return claudeLiveUsage(account.id, env, force);
    };
    const asFailure = (problem: string): LiveUsage => ({
      available: false, session: null, week: null, weekModels: [],
      fetchedAt: 0, cached: false, problem,
    });

    (async () => {
      const forced = reload > 0;

      if (!forced) {
        setAsking(true);
        const stored = await ask(false).catch(() => null);
        if (stale) return;
        if (stored) setLive(stored);
        setAsking(false);
        // Lo guardado todavía sirve: no hay nada más que hacer.
        if (stored?.available && isUsageFresh(stored.fetchedAt, Math.floor(Date.now() / 1000))) {
          return;
        }
      }

      setRefreshing(true);
      const fresh = await ask(true).catch((e) => asFailure(String(e)));
      if (stale) return;
      setLive(fresh);
      setRefreshing(false);
    })();

    return () => { stale = true; };
  }, [account, reload]);

  const plan = planLabel(usage?.plan.tier ?? null);
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="flex flex-col gap-3 w-72 p-3.5">
      <div className="flex items-center gap-2.5">
        <Icon className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[12.5px] font-semibold truncate text-gray-900 dark:text-white">
            {account.label ?? account.name}
          </span>
          <span className="text-[10px] font-mono truncate text-gray-400 dark:text-white/35">
            {account.id.startsWith("system:") ? t("accounts.system") : account.name}
          </span>
        </span>
        {plan ? (
          <Badge variant="accent" size="sm" className="shrink-0">{plan}</Badge>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0
            ${account.loggedIn ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/20"}`} />
        )}
      </div>

      {/* ══ el cupo del plan, preguntado en vivo ══════════════════════ */}
      {account.agentId === "claude-code" && (
        <div className="flex flex-col gap-2">
          {asking && !live ? (
            <Progress indeterminate size="sm" label={
              <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                {t("accounts.plan.asking")}
              </span>
            } />
          ) : live?.available ? (
            <>
              {live.session && (
                <Progress
                  value={live.session.percent}
                  max={100}
                  size="sm"
                  showValue
                  variant={live.session.percent >= 80 ? "warning" : "accent"}
                  label={
                    <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                      {t("accounts.plan.session")}
                      {live.session.resets && (
                        <span className="ml-1.5 text-gray-400 dark:text-white/30">
                          · {live.session.resets}
                        </span>
                      )}
                    </span>
                  }
                />
              )}
              {live.week && (
                <Progress
                  value={live.week.percent}
                  max={100}
                  size="sm"
                  showValue
                  variant={live.week.percent >= 80 ? "warning" : "info"}
                  label={
                    <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                      {t("accounts.plan.week")}
                      {live.week.resets && (
                        <span className="ml-1.5 text-gray-400 dark:text-white/30">
                          · {live.week.resets}
                        </span>
                      )}
                    </span>
                  }
                />
              )}
              {live.weekModels.map(({ model, meter }) => (
                <Progress
                  key={model}
                  value={meter.percent}
                  max={100}
                  size="xs"
                  showValue
                  variant={meter.percent >= 80 ? "warning" : "info"}
                  label={
                    <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                      {t("accounts.plan.weekModel", { model })}
                    </span>
                  }
                />
              ))}

              {/* Cuándo se preguntó de verdad. Sin esto, un número de hace cinco minutos
                  se lee como si fuera de ahora mismo. */}
              <div className="flex items-center gap-2 pt-0.5">
                <span className="flex-1 text-[10px] text-gray-400 dark:text-white/30">
                  {(() => {
                    const ago = formatAgo(now - live.fetchedAt);
                    return t(`accounts.plan.ago.${ago.unit}`, { n: ago.value });
                  })()}
                </span>
                {refreshing && (
                  <span className="text-[10px] text-gray-400 dark:text-white/30">
                    {t("accounts.plan.asking")}
                  </span>
                )}
                <button
                  onClick={() => setReload((n) => n + 1)}
                  disabled={refreshing}
                  title={t("accounts.plan.refresh")}
                  className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
                    text-gray-400 dark:text-white/35
                    hover:text-gray-700 dark:hover:text-white
                    hover:bg-gray-200 dark:hover:bg-white/10
                    disabled:opacity-40"
                >
                  <RefreshIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          ) : live ? (
            <Alert variant="neutral">{live.problem ?? t("accounts.plan.failed")}</Alert>
          ) : null}
        </div>
      )}

      {/* Las demás TUIs no dicen cuánto cupo queda. Lo que sí hay en disco (tokens de los
          transcripts) no es la cuota, y mostrarlo acá se leía como si lo fuera. */}
      {account.agentId !== "claude-code" && (
        <p className="text-[11px] text-gray-400 dark:text-white/35">
          {t("accounts.plan.unsupported")}
        </p>
      )}
    </div>
  );
}
