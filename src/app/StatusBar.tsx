import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAccountsStore } from "@/features/accounts/store";
import { useTabsStore } from "@/features/tabs/store";
import { useUiStore } from "@/app/uiStore";
import { agentIcon } from "@/features/agents/agentIcons";
import { OrchestratorIndicator } from "@/features/orchestrator/OrchestratorIndicator";
import { BranchIcon } from "@/app/icons";
import type { RepoInfo } from "@/features/explorer/types";

/**
 * La franja de abajo: las cuentas con sesión iniciada, y el estado de la tab activa.
 *
 * Las cuentas van acá y no repetidas en cada tab porque el login es por CUENTA: varias
 * tabs de la misma TUI comparten una sola. Verlas todas juntas es lo que hace evidente
 * con cuál está corriendo cada cosa.
 */
export function StatusBar({ repo }: { repo: RepoInfo | null }) {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const load = useAccountsStore((s) => s.load);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => { load().catch(console.error); }, [load]);

  // Solo las que tienen sesión: una cuenta creada y nunca logueada no dice nada útil acá,
  // y la lista se llenaría de perfiles vacíos.
  const signedIn = accounts.filter((a) => a.loggedIn);

  return (
    <footer className="flex items-center gap-2.5 h-[26px] shrink-0 px-3
      bg-gray-100 dark:bg-gray-900
      border-t border-gray-200 dark:border-white/7
      text-[10.5px] tabular-nums text-gray-500 dark:text-gray-400 select-none">

      {signedIn.map((account) => {
        const Icon = agentIcon(account.agentId, account.agentId);
        return (
          <button
            key={account.id}
            onClick={() => setSettingsOpen(true)}
            title={t("status.account", { agent: account.agentId, name: account.label ?? account.name })}
            className="flex items-center gap-1.5 h-5 shrink-0 pl-1.5 pr-2.5 rounded-full max-w-52
              bg-gray-200/70 dark:bg-white/5
              hover:bg-gray-300/70 dark:hover:bg-white/10 transition-colors"
          >
            <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400" />
            <span className="truncate text-[10px] font-medium text-gray-700 dark:text-gray-300">
              {account.label ?? account.name}
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          </button>
        );
      })}

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
