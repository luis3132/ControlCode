import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { systemAccounts } from "@/features/accounts/usage";
import { UsageBoard } from "@/features/accounts/UsageBoard";
import { LoginTerminal } from "@/features/accounts/LoginTerminal";
import { DualRing } from "@/features/accounts/Ring";
import { measurable, useUsageStore, useUsageWindows } from "@/features/accounts/usageStore";
import { AppDialog } from "@/shared/ui/AppDialog";
import type { AgentAccount } from "@/features/accounts/types";
import { useTabsStore } from "@/features/tabs/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { OrchestratorIndicator } from "@/features/orchestrator/OrchestratorIndicator";
import { FleetIndicator } from "@/features/runs/FleetIndicator";
import { ProcessIndicator } from "@/features/processes/ProcessIndicator";
import { BranchIcon } from "@/app/icons";
import type { RepoInfo } from "@/features/explorer/types";

/**
 * La franja de abajo: las cuentas de cada TUI, y el estado de la tab activa.
 *
 * Las cuentas van acá y no repetidas en cada tab porque el login es por CUENTA: varias
 * tabs de la misma TUI comparten una sola.
 *
 * Y se lista PRIMERO la principal de cada TUI — la que se usa cuando no hay ningún perfil
 * de por medio. No tiene fila en la base (existía antes que esta app), así que hasta ahora
 * la barra mostraba los perfiles alternativos y escondía justo la que se usa siempre.
 */
/** Un chip de cuenta: el anillo dice cuánto lleva la sesión (afuera) y la semana (adentro). */
function AccountChip({ account, active, onClick }: { account: AgentAccount; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const { session, week } = useUsageWindows(account);
  const Icon = agentIcon(account.agentId, account.agentId);
  const name = account.label ?? account.name;
  // Sin ventana corta (Codex en el plan gratis) la de afuera es la única que hay.
  const outer = session ?? week;
  const inner = session !== null ? week : null;
  const parts = [
    session !== null && t("accounts.ring.session", { n: session }),
    week !== null && t("accounts.ring.week", { n: week }),
  ].filter(Boolean);
  return (
    <Button variant="custom"
      onClick={onClick}
      title={parts.length ? `${name} · ${parts.join(" · ")}` : name}
      className={`cc-t flex items-center gap-1.5 h-5 shrink-0 pl-1.5 pr-2 rounded-full max-w-52
        ${active
          ? "bg-gray-300/80 dark:bg-white/12"
          : "bg-gray-200/70 dark:bg-white/5 hover:bg-gray-300/70 dark:hover:bg-white/10"}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
      <span className="truncate text-[10px] font-medium text-gray-700 dark:text-gray-300">
        {account.label ?? account.name}
      </span>
      {measurable(account.agentId) ? (
        <span className="text-gray-400 dark:text-white">
          <DualRing outer={outer} inner={inner} agentId={account.agentId} size={14} />
        </span>
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0
          ${account.loggedIn ? "bg-emerald-500" : "bg-gray-400 dark:bg-white/25"}`} />
      )}
    </Button>
  );
}

export function StatusBar({ repo }: { repo: RepoInfo | null }) {
  const { t } = useTranslation();
  const profiles = useAccountsStore((s) => s.accounts);
  const load = useAccountsStore((s) => s.load);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const [system, setSystem] = useState<AgentAccount[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<AgentAccount | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load().catch(console.error);
    systemAccounts().then(setSystem).catch(console.error);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // La principal de cada TUI instalada, más los perfiles con sesión iniciada: un perfil
  // creado y nunca logueado no dice nada acá y solo llenaría la barra.
  const shown = [...system, ...profiles.filter((a) => a.loggedIn)];
  const shownKey = shown.map((a) => a.id).join("|");

  // Al arrancar, solo lo guardado: llena los anillos sin levantar ninguna TUI.
  useEffect(() => {
    const { refresh } = useUsageStore.getState();
    for (const a of shown) if (measurable(a.agentId)) void refresh(a, "cache");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  // Con el panel abierto se pregunta lo que venció, y de nuevo cada cinco minutos. Las de
  // Claude de a una: cada consulta levanta una TUI entera.
  const panelOpen = open !== null;
  useEffect(() => {
    if (!panelOpen) return;
    const sweep = async () => {
      const { refresh } = useUsageStore.getState();
      const list = shown.filter((a) => measurable(a.agentId));
      await Promise.all(list.filter((a) => a.agentId !== "claude-code").map((a) => refresh(a, "stale")));
      for (const a of list.filter((x) => x.agentId === "claude-code")) await refresh(a, "stale");
    };
    void sweep();
    const timer = window.setInterval(() => void sweep(), 5 * 60 * 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, shownKey]);

  // La cuenta que se tocó queda a la vista dentro del panel.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector(`[data-account="${CSS.escape(open)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <footer className="relative flex items-center gap-2.5 h-[26px] shrink-0 px-3
      bg-gray-100 dark:bg-surface-sunken
      border-t border-gray-200 dark:border-white/7
      text-[10.5px] tabular-nums text-gray-500 dark:text-gray-400 select-none">

      {shown.map((account) => (
        <AccountChip
          key={account.id}
          account={account}
          active={open === account.id}
          onClick={() => setOpen((current) => (current === account.id ? null : account.id))}
        />
      ))}

      {/* El panel se abre HACIA ARRIBA: la barra es lo último de la ventana. */}
      {open && (
        <div
          ref={popRef}
          className="cc-rise absolute bottom-[30px] left-3 z-50 w-[22rem] max-w-[calc(100vw-1.5rem)]
            flex flex-col max-h-[min(36rem,calc(100vh-5rem))]
            rounded-xl overflow-hidden
            bg-white dark:bg-surface
            border border-gray-200 dark:border-white/12
            shadow-2xl"
        >
          <div className="shrink-0 px-4 py-2.5 border-b border-gray-100 dark:border-white/6
            text-[12px] font-semibold text-gray-900 dark:text-white">
            {t("accounts.usage.title")}
          </div>
          <div className="overflow-y-auto">
            <UsageBoard accounts={shown} onLogin={(a) => { setOpen(null); setLoginFor(a); }} />
          </div>
        </div>
      )}

      {loginFor && (
        <AppDialog
          title={t("settings.accounts.login.title", { name: loginFor.name })}
          onClose={() => setLoginFor(null)}
          size="lg"
          closeOnBackdrop={false}
          closeOnEsc={false}
          footer={
            <Button variant="primary" onClick={() => {
              const account = loginFor;
              setLoginFor(null);
              load().catch(console.error);
              void useUsageStore.getState().refresh(account, "force");
            }}>
              {t("settings.accounts.login.done")}
            </Button>
          }
        >
          <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
            {t("settings.accounts.login.helper", { command: loginFor.loginCommand })}
          </p>
          <LoginTerminal account={loginFor} />
        </AppDialog>
      )}

      <div className="flex-1" />

      {repo?.branch && (
        <>
          <span className="flex items-center gap-1.5 min-w-0 max-w-56">
            <BranchIcon className="w-3 h-3 shrink-0" />
            <span className="truncate font-mono">{repo.branch}</span>
          </span>
          <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
        </>
      )}

      {activeTab && (
        <>
          <span className="truncate max-w-96 font-mono">{activeTab.cwd}</span>
          <span className="w-px h-3 bg-gray-300 dark:bg-white/10" />
        </>
      )}

      <span>{t("status.agents", { n: tabs.length })}</span>
      <FleetIndicator />
      <ProcessIndicator />
      <OrchestratorIndicator />
    </footer>
  );
}
