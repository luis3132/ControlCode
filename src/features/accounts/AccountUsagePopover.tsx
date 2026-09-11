import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Progress, Skeleton } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { agentAccountUsage, formatTokens, totalOf, type AccountUsage } from "./usage";
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
export function AccountUsagePopover({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [failed, setFailed] = useState(false);
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

  const week = usage?.windows.find((w) => w.key === "7d");
  const reference = week ? totalOf(week) : 0;

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
        <span className={`w-1.5 h-1.5 rounded-full shrink-0
          ${account.loggedIn ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/20"}`} />
      </div>

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
          <div className="flex flex-col gap-2.5">
            {usage.windows.map((w) => (
              <Progress
                key={w.key}
                value={totalOf(w)}
                max={reference}
                size="xs"
                variant={w.key === "5h" ? "accent" : "info"}
                label={
                  <span className="text-[10.5px] text-gray-500 dark:text-gray-400">
                    {t(`accounts.usage.window.${w.key}`)}
                    <span className="ml-1.5 font-mono tabular-nums text-gray-700 dark:text-gray-300">
                      {formatTokens(totalOf(w))}
                    </span>
                  </span>
                }
              />
            ))}
          </div>

          {/* El desglose de la ventana más corta, que es la que importa ahora mismo. */}
          {usage.windows[0] && (
            <div className="flex flex-col gap-1 pt-2.5 border-t border-gray-200 dark:border-white/8">
              <Row label={t("accounts.usage.input")} value={formatTokens(usage.windows[0].inputTokens)} />
              <Row label={t("accounts.usage.output")} value={formatTokens(usage.windows[0].outputTokens)} />
              <Row label={t("accounts.usage.cache")} value={formatTokens(usage.windows[0].cacheReadTokens)} />
              <Row label={t("accounts.usage.sessions")} value={String(usage.windows[0].sessions)} />
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-gray-400 dark:text-white/30">
            {t("accounts.usage.source", { files: usage.scannedFiles })}
          </p>
        </>
      )}
    </div>
  );
}
