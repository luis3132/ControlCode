import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Progress, Skeleton } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { agentIcon } from "@/features/agents/agentIcons";
import type { QuotaWindow } from "@/features/runs/types";

import { accountProblemText, needsLogin } from "./problem";
import { Ring, agentColor, usageColor } from "./Ring";
import type { AgentAccount } from "./types";
import { formatAgo } from "./usage";
import { useHeadline, useUsageStore } from "./usageStore";

type T = (key: string, options?: Record<string, unknown>) => string;

/** Cuadros de cada barra: con 32, cada uno es un poco más de un 3 %. */
const SEGMENTS = 32;

/**
 * Un límite: nombre, porcentaje, la barra en cuadros y cuándo se reinicia. El color es el
 * del agente hasta que el uso sube; ahí pasa a ámbar y a rojo.
 */
function Meter({ label, percent, resets, agentId }: {
  label: string;
  percent: number;
  resets: string | null;
  agentId: string;
}) {
  const color = usageColor(percent, agentId);
  return (
    <div>
      <Progress
        value={Math.min(percent, 100)}
        segments={SEGMENTS}
        size="sm"
        showValue
        label={<span className="text-[12px] font-medium text-gray-800 dark:text-gray-100">{label}</span>}
        style={{ "--nui-accent": color, "--nui-accent-dark": color } as CSSProperties}
      />
      {resets && <div className="mt-1 text-[10.5px] text-gray-400 dark:text-gray-500">{resets}</div>}
    </div>
  );
}

/** Lo que falta para un instante, en palabras: «en 1 h 20 min», «en 6 días». */
export function untilText(at: number | null, now: number, t: T): string | null {
  if (!at) return null;
  const secs = at - now;
  if (secs <= 0) return t("accounts.usage.resetsNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("accounts.usage.resetsIn", { value: `${Math.max(1, mins)} min` });
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return t("accounts.usage.resetsIn", { value: mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h` });
  }
  return t("accounts.usage.resetsIn", { value: t("accounts.usage.days", { count: Math.round(hours / 24) }) });
}

/**
 * El nombre de una ventana de Codex por lo que dura, no por si vino como la corta o la
 * larga: el plan gratis tiene una sola, de un mes, y llamarla «semanal» mentía.
 */
export function windowLabel(window: QuotaWindow, fallback: "session" | "week", t: T): string {
  const mins = window.windowMins ?? null;
  if (mins === 300) return t("accounts.plan.session");
  if (mins === 10080) return t("accounts.plan.week");
  if (mins !== null && mins >= 28 * 24 * 60 && mins <= 31 * 24 * 60) return t("accounts.usage.month");
  if (mins !== null && mins > 0) {
    return mins % 1440 === 0
      ? t("accounts.usage.windowDays", { count: mins / 1440 })
      : t("accounts.usage.windowHours", { count: Math.round(mins / 60) });
  }
  return t(fallback === "session" ? "accounts.plan.session" : "accounts.plan.week");
}

/** El encabezado de cada cuenta: el anillo con el uso alrededor del icono, nombre y cuenta. */
function Head({ account, plan, children }: { account: AgentAccount; plan: string | null; children?: ReactNode }) {
  const { t } = useTranslation();
  const percent = useHeadline(account);
  const Icon = agentIcon(account.agentId, account.agentId);
  const name = t(`accounts.usage.agent.${account.agentId}`, { defaultValue: account.agentId });
  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0 flex items-center justify-center w-11 h-11 text-gray-400 dark:text-white">
        <Ring percent={percent} color={percent === null ? agentColor(account.agentId) : usageColor(percent, account.agentId)} size={44} stroke={3.5} />
        <Icon className="absolute w-4.5 h-4.5 text-gray-600 dark:text-gray-300" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-gray-900 dark:text-white">{name}</span>
          {plan && <Badge variant="neutral" size="sm" className="shrink-0 uppercase tracking-wide">{plan}</Badge>}
        </div>
        <div title={account.label ?? account.name} className="truncate text-[11px] text-gray-500 dark:text-gray-400">
          {account.id.startsWith("system:") && !account.label ? t("accounts.system") : account.label ?? account.name}
        </div>
      </div>
      {children}
    </div>
  );
}

function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="icon" onClick={onClick} disabled={busy} title={t("accounts.usage.refresh")}
      aria-label={t("accounts.usage.refresh")}
      className="cc-t shrink-0 flex items-center justify-center w-7 h-7 p-0 rounded-full
        text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white
        hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-50">
      <RefreshIcon className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
    </Button>
  );
}

const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-3 w-24" />
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-20" />
    <Skeleton className="h-3 w-full" />
  </div>
);

function Updated({ at, now }: { at: number; now: number }) {
  const { t } = useTranslation();
  const ago = formatAgo(now - at);
  return <div className="text-[10px] text-gray-400 dark:text-gray-500">{t(`accounts.plan.ago.${ago.unit}`, { n: ago.value })}</div>;
}

/** Que no se pudo, con la salida si la hay: volver a loguearse, o volver a probar. */
function Problem({ problem, onLogin, onRetry, busy }: {
  problem: string | null;
  onLogin: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const login = needsLogin(problem);
  return (
    <div className="flex flex-col gap-2">
      <Alert variant={login ? "warning" : "neutral"}>{accountProblemText(problem, t)}</Alert>
      <div className="flex gap-2">
        {login && <Button variant="outline" size="sm" onClick={onLogin}>{t("settings.accounts.relogin")}</Button>}
        <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>{t("accounts.usage.retry")}</Button>
      </div>
    </div>
  );
}

/**
 * Claude Code: la sesión de cinco horas, la semana y la semana por modelo. Sale de
 * preguntarle `/usage` a la propia TUI (ver `usage/live.rs`).
 */
function ClaudeSection({ account, onLogin }: { account: AgentAccount; onLogin: () => void }) {
  const { t } = useTranslation();
  const live = useUsageStore((s) => s.claude[account.id]) ?? null;
  const plan = useUsageStore((s) => s.plan[account.id]) ?? null;
  const busy = useUsageStore((s) => !!s.busy[account.id]);
  const force = () => void useUsageStore.getState().refresh(account, "force");
  const resets = (text: string | null) => (text ? t("accounts.usage.resetsAt", { when: text }) : null);
  const now = Math.floor(Date.now() / 1000);

  return (
    <section className="flex flex-col gap-3.5 px-4 py-4">
      <Head account={account} plan={plan}><RefreshButton busy={busy} onClick={force} /></Head>
      {live === null ? <Loading /> : live.available ? (
        <>
          {live.session && <Meter label={t("accounts.plan.session")} percent={live.session.percent} resets={resets(live.session.resets)} agentId={account.agentId} />}
          {live.week && <Meter label={t("accounts.plan.week")} percent={live.week.percent} resets={resets(live.week.resets)} agentId={account.agentId} />}
          {live.weekModels.map(({ model, meter }) => (
            <Meter key={model} label={t("accounts.plan.weekModel", { model })} percent={meter.percent} resets={resets(meter.resets)} agentId={account.agentId} />
          ))}
          {live.fetchedAt > 0 && <Updated at={live.fetchedAt} now={now} />}
        </>
      ) : (
        <Problem problem={live.problem} onLogin={onLogin} onRetry={force} busy={busy} />
      )}
    </section>
  );
}

/** Codex: sus ventanas, según su `app-server`. Con API key no hay: se cobra por uso. */
function CodexSection({ account, onLogin }: { account: AgentAccount; onLogin: () => void }) {
  const { t } = useTranslation();
  const entry = useUsageStore((s) => s.codex[account.id]);
  const busy = useUsageStore((s) => !!s.busy[account.id]);
  const force = () => void useUsageStore.getState().refresh(account, "force");
  const usage = entry?.usage ?? null;
  const quota = usage?.quota ?? null;
  const now = Math.floor(Date.now() / 1000);
  const meter = (w: QuotaWindow | null, fallback: "session" | "week") =>
    w && <Meter label={windowLabel(w, fallback, t)} percent={Math.round(w.utilization * 100)} resets={untilText(w.resetsAt, now, t)} agentId={account.agentId} />;

  return (
    <section className="flex flex-col gap-3.5 px-4 py-4">
      <Head account={account} plan={usage?.plan ?? null}><RefreshButton busy={busy} onClick={force} /></Head>
      {entry?.problem && !usage ? (
        <Problem problem={entry.problem} onLogin={onLogin} onRetry={force} busy={busy} />
      ) : !usage ? <Loading /> : usage.auth === "apiKey" || !quota ? (
        <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("accounts.usage.codexApiKey")}</p>
      ) : (
        <>
          {quota.rejected && <Alert variant="warning">{t("accounts.usage.codexLimited")}</Alert>}
          {meter(quota.fiveHour, "session")}
          {meter(quota.sevenDay, "week")}
          {usage.fetchedAt > 0 && <Updated at={usage.fetchedAt} now={now} />}
        </>
      )}
    </section>
  );
}

/** Los agentes que no informan un cupo: se dice, en vez de mostrar una barra inventada. */
function OtherSection({ account }: { account: AgentAccount }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3 px-4 py-4">
      <Head account={account} plan={null} />
      <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("accounts.plan.unsupported")}</p>
    </section>
  );
}

/** Todas las cuentas, una debajo de otra. Los datos viven en `usageStore`. */
export function UsageBoard({ accounts, onLogin }: { accounts: AgentAccount[]; onLogin: (account: AgentAccount) => void }) {
  return (
    <div className="divide-y divide-gray-100 dark:divide-white/6">
      {accounts.map((a) => (
        <div key={a.id} data-account={a.id}>
          {a.agentId === "claude-code" ? <ClaudeSection account={a} onLogin={() => onLogin(a)} />
            : a.agentId === "codex" ? <CodexSection account={a} onLogin={() => onLogin(a)} />
            : <OtherSection account={a} />}
        </div>
      ))}
    </div>
  );
}

