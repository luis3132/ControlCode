import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccountsStore } from "@/features/accounts/store";
import { systemAccounts } from "@/features/accounts/usage";
import { AccountUsagePopover } from "@/features/accounts/AccountUsagePopover";
import type { AgentAccount } from "@/features/accounts/types";
import { useTabsStore } from "@/features/tabs/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { OrchestratorIndicator } from "@/features/orchestrator/OrchestratorIndicator";
import { BranchIcon } from "@/app/icons";
import { homeDir } from "@/shared/ipc/window";
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
export function StatusBar({ repo }: { repo: RepoInfo | null }) {
  const { t } = useTranslation();
  const profiles = useAccountsStore((s) => s.accounts);
  const load = useAccountsStore((s) => s.load);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const [system, setSystem] = useState<AgentAccount[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load().catch(console.error);
    systemAccounts().then(setSystem).catch(console.error);
    homeDir().then(setHome).catch(() => setHome(null));
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

  /** Preguntarle el cupo a la TUI necesita una carpeta que ella ya considere de confianza.
   *  La de una tab abierta de ese mismo agente lo es con certeza — está corriendo ahí. */
  const probeCwd = (agentId: string): string | null =>
    tabs.find((tab) => tab.agentId === agentId)?.cwd ?? home;

  return (
    <footer className="relative flex items-center gap-2.5 h-[26px] shrink-0 px-3
      bg-gray-100 dark:bg-[#0a0f16]
      border-t border-gray-200 dark:border-white/7
      text-[10.5px] tabular-nums text-gray-500 dark:text-gray-400 select-none">

      {shown.map((account) => {
        const Icon = agentIcon(account.agentId, account.agentId);
        return (
          <button
            key={account.id}
            onClick={() => setOpen((current) => (current === account.id ? null : account.id))}
            title={account.label ?? account.name}
            className={`cc-t flex items-center gap-1.5 h-5 shrink-0 pl-1.5 pr-2.5 rounded-full max-w-52
              ${open === account.id
                ? "bg-gray-300/80 dark:bg-white/12"
                : "bg-gray-200/70 dark:bg-white/5 hover:bg-gray-300/70 dark:hover:bg-white/10"}`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
            <span className="truncate text-[10px] font-medium text-gray-700 dark:text-gray-300">
              {account.label ?? account.name}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0
              ${account.loggedIn ? "bg-emerald-500" : "bg-gray-400 dark:bg-white/25"}`} />
          </button>
        );
      })}

      {/* El panel se abre HACIA ARRIBA: la barra es lo último de la ventana. */}
      {open && (
        <div
          ref={popRef}
          className="cc-rise absolute bottom-[30px] left-3 z-50
            rounded-xl overflow-hidden
            bg-white dark:bg-[#0d1117]
            border border-gray-200 dark:border-white/12
            shadow-2xl"
        >
          <AccountUsagePopover
            account={shown.find((a) => a.id === open)!}
            cwd={probeCwd(shown.find((a) => a.id === open)!.agentId)}
          />
        </div>
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
      <OrchestratorIndicator />
    </footer>
  );
}
