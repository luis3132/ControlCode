import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Progress, Skeleton } from "neogestify-ui-components";
import { RefreshIcon } from "@/app/icons";

import { agentIcon } from "@/features/agents/agentIcons";
import {
  WINDOW_SECS, agentAccountUsage, claudeLiveUsage, formatAgo, formatRemaining, formatTokens,
  planLabel, totalOf, type AccountUsage, type LiveUsage,
} from "./usage";
import { accountEnv } from "./ipc";
import type { AgentAccount } from "./types";

/** Un perfil sintético (`system:*`) no tiene fila en la base: para el backend es `null`. */
function realAccountId(account: AgentAccount): string | null {
  return account.id.startsWith("system:") ? null : account.id;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-[11.5px] font-mono tabular-nums text-gray-700 dark:text-gray-200">
        {value}
      </span>
    </div>
  );
}

/**
 * El consumo real de una cuenta, leído de los transcripts de su TUI.
 *
 * ## Lo que la barra NO dice, y por qué
 *
 * No hay porcentaje de cuota. Cuánto queda de la ventana del plan no está en ningún
 * archivo local ni hay API para preguntarlo, así que la barra mide lo único medible: qué
 * parte de lo que gastaste en la semana cayó en cada ventana. Sirve para ver si la tarde
 * viene cargada; no es un medidor de límite, y por eso la etiqueta no lo insinúa.
 */
export function AccountUsagePopover({ account, cwd }: {
  account: AgentAccount;
  /** Carpeta de confianza donde abrir el sondeo. Sin una, no se pregunta. */
  cwd: string | null;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [live, setLive] = useState<LiveUsage | null>(null);
  const [asking, setAsking] = useState(false);
  /** Sube al apretar refrescar: obliga a preguntar de nuevo en vez de releer la caché. */
  const [reload, setReload] = useState(0);
  const Icon = agentIcon(account.agentId, account.agentId);

  useEffect(() => {
    let stale = false;
    setUsage(null);
    setFailed(false);
    agentAccountUsage(account.agentId, realAccountId(account))
      .then((u) => { if (!stale) setUsage(u); })
      .catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [account]);

  // El cupo del plan no está en ningún archivo: hay que preguntárselo a la TUI. Cuesta
  // unos segundos y levanta un proceso, así que se hace al abrir el panel y una sola vez.
  useEffect(() => {
    if (account.agentId !== "claude-code" || !cwd) return;
    let stale = false;
    setLive(null);
    setAsking(true);

    const vars = realAccountId(account) ? accountEnv(account.id) : Promise.resolve({});
    vars
      .then((env) => claudeLiveUsage(account.id, cwd, env, reload > 0))
      .then((l) => { if (!stale) setLive(l); })
      .catch((e) => { if (!stale) setLive({
        available: false, session: null, week: null, weekModels: [],
        fetchedAt: 0, cached: false, problem: String(e),
      }); })
      .finally(() => { if (!stale) setAsking(false); });

    return () => { stale = true; };
  }, [account, cwd, reload]);

  const week = usage?.windows.find((w) => w.key === "7d");
  const reference = week ? totalOf(week) : 0;
  const plan = planLabel(usage?.plan.tier ?? null);

  // Cuándo se reabre la ventana. Manda lo que dijo el SERVIDOR si es de esta misma
  // ventana; si no, el arranque deducido de las marcas de los mensajes.
  const now = Math.floor(Date.now() / 1000);
  const serverFresh =
    usage?.serverResetsAt != null && usage.serverResetsAt > now ? usage.serverResetsAt : null;
  const resetsAt = serverFresh ?? usage?.windowResetsAt ?? null;
  const startedAt = usage?.windowStartedAt ?? null;

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
          {asking ? (
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
                <button
                  onClick={() => setReload((n) => n + 1)}
                  title={t("accounts.plan.refresh")}
                  className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
                    text-gray-400 dark:text-white/35
                    hover:text-gray-700 dark:hover:text-white
                    hover:bg-gray-200 dark:hover:bg-white/10"
                >
                  <RefreshIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          ) : live ? (
            <Alert variant="neutral">{live.problem ?? t("accounts.plan.failed")}</Alert>
          ) : !cwd ? (
            <Alert variant="neutral">{t("accounts.plan.noFolder")}</Alert>
          ) : null}
        </div>
      )}

      {failed ? (
        <Alert variant="danger">{t("accounts.usage.failed")}</Alert>
      ) : !usage ? (
        <Skeleton variant="text" lines={4} />
      ) : !usage.available ? (
        <Alert variant="neutral">{t("accounts.usage.unsupported")}</Alert>
      ) : reference === 0 ? (
        <p className="text-[11.5px] text-gray-400 dark:text-white/35">
          {t("accounts.usage.none")}
        </p>
      ) : (
        <>
          {/* La ÚNICA barra con un denominador real: el tiempo de la ventana. Los cinco
              minutos que pasaron son cinco minutos; el porcentaje de cupo consumido no se
              puede saber desde acá y no se dibuja. */}
          {startedAt && resetsAt ? (
            <div className="flex flex-col gap-1">
              <Progress
                value={Math.min(WINDOW_SECS, now - startedAt)}
                max={WINDOW_SECS}
                size="sm"
                variant={resetsAt - now < 1800 ? "warning" : "accent"}
                label={
                  <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                    {t("accounts.usage.windowLeft", { time: formatRemaining(resetsAt - now) })}
                  </span>
                }
              />
              <span className="text-[10px] text-gray-400 dark:text-white/30">
                {serverFresh
                  ? t("accounts.usage.resetFromServer")
                  : t("accounts.usage.resetDerived")}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-gray-400 dark:text-white/35">
              {t("accounts.usage.windowClosed")}
            </p>
          )}

          <div className="flex flex-col gap-1.5 pt-2.5 border-t border-gray-200 dark:border-white/8">
            {usage.windows.map((w) => (
              <Row
                key={w.key}
                label={t(`accounts.usage.window.${w.key}`)}
                value={`${formatTokens(totalOf(w))} · ${w.sessions} ${t("accounts.usage.sessionsShort")}`}
              />
            ))}
          </div>

          {/* El desglose de la ventana en curso, que es la que importa ahora mismo. */}
          {usage.windows[0] && (
            <div className="flex flex-col gap-1 pt-2.5 border-t border-gray-200 dark:border-white/8">
              <Row label={t("accounts.usage.input")} value={formatTokens(usage.windows[0].inputTokens)} />
              <Row label={t("accounts.usage.output")} value={formatTokens(usage.windows[0].outputTokens)} />
              <Row label={t("accounts.usage.cache")} value={formatTokens(usage.windows[0].cacheReadTokens)} />
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-gray-400 dark:text-white/30">
            {t("accounts.usage.noQuota")}
          </p>
        </>
      )}
    </div>
  );
}
