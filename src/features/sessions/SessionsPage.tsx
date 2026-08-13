import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ClockIcon, FolderIcon, ChevronDownIcon } from "neogestify-ui-components";
import { useSessionsStore } from "@/features/sessions/store";
import type { SessionHistoryEntry } from "@/features/sessions/types";
import { useTabsStore } from "@/features/tabs/store";
import { useAccountsStore } from "@/features/accounts/store";
import { PageHeader } from "@/shared/ui/PageHeader";
import { MissingSkillsDialog } from "@/features/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "@/features/sessions/ResumeOptionsDialog";
import { SessionRow } from "@/features/sessions/SessionRow";
import { SessionFilters } from "@/features/sessions/SessionFilters";
import {
  EMPTY_FILTERS,
  filterSessions,
  hasActiveFilters,
  type SessionFilterState,
} from "@/features/sessions/filters";
import { useResumeSession } from "./useResumeSession";

export function SessionsPage() {
  const { t } = useTranslation();
  const history = useSessionsStore((s) => s.history);
  const loadHistory = useSessionsStore((s) => s.loadHistory);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const {
    pendingResume,
    setPendingResume,
    pendingSkillChoice,
    setPendingSkillChoice,
    openSession,
    resume,
    resumeWithOptions,
  } = useResumeSession();
  // Para poder nombrar la cuenta de cada sesión (ver SessionRow): la lista guarda el id,
  // no el nombre, así que sin esto las filas no tendrían con qué resolverlo.
  const loadAccounts = useAccountsStore((s) => s.load);
  const [filters, setFilters] = useState<SessionFilterState>(EMPTY_FILTERS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => { loadAccounts().catch(console.error); }, [loadAccounts]);

  useEffect(() => {
    loadHistory(workspaceId);
    // Otra ventana del mismo workspace pudo haber cerrado una tab mientras esta página
    // estaba abierta — mismo patrón de refresco que Home/Workspaces.
    const unlisten = listen("cc-workspace-changed", () => loadHistory(workspaceId));
    return () => { unlisten.then((fn) => fn()); };
  }, [workspaceId, loadHistory]);

  const visible = useMemo(() => filterSessions(history, filters), [history, filters]);

  /** Sesiones agrupadas por carpeta, cada grupo ordenado por cierre más reciente. */
  const groups = useMemo(() => {
    const byCwd = new Map<string, SessionHistoryEntry[]>();
    for (const entry of visible) {
      const list = byCwd.get(entry.cwd);
      if (list) list.push(entry);
      else byCwd.set(entry.cwd, [entry]);
    }
    return Array.from(byCwd.entries())
      .map(([cwd, entries]) => ({ cwd, entries }))
      // El grupo con la actividad más reciente va primero, no el alfabético: al volver a
      // Sesiones, lo que buscás casi siempre es lo último que cerraste.
      .sort((a, b) => b.entries[0].closedAt - a.entries[0].closedAt);
  }, [visible]);

  const toggleGroup = (cwd: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">

        <PageHeader
          icon={<ClockIcon className="w-5 h-5" />}
          title={t("sessions.title")}
          subtitle={t("sessions.subtitle")}
        />

        {history.length === 0 ? (
          <p className="text-sm italic text-gray-400 dark:text-gray-500">
            {t("sessions.empty")}
          </p>
        ) : (
          <>
            <SessionFilters
              entries={history}
              value={filters}
              onChange={setFilters}
              resultCount={visible.length}
            />

            {visible.length === 0 ? (
              <p className="text-sm italic text-gray-400 dark:text-gray-500">
                {t("sessions.noMatches")}
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {groups.map(({ cwd, entries }) => {
                  const isCollapsed = collapsed.has(cwd);
                  return (
                    <section key={cwd} className="flex flex-col gap-2">
                      {/* La agrupación por carpeta solo aporta cuando hay más de una:
                          con una sola, el encabezado repetiría lo que ya dice cada fila. */}
                      {groups.length > 1 && (
                        <button
                          onClick={() => toggleGroup(cwd)}
                          className="flex items-center gap-1.5 w-fit max-w-full text-xs font-medium
                            text-gray-500 dark:text-gray-400
                            hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
                        >
                          <ChevronDownIcon
                            className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200
                              ${isCollapsed ? "-rotate-90" : ""}`}
                          />
                          <FolderIcon className="w-3.5 h-3.5 shrink-0" />
                          <span className="font-mono truncate">{cwd}</span>
                          <span className="text-gray-400 dark:text-gray-500 shrink-0">
                            ({entries.length})
                          </span>
                        </button>
                      )}

                      {!isCollapsed && (
                        <div className="flex flex-col gap-2">
                          {entries.map((entry) => (
                            <SessionRow
                              key={entry.id}
                              entry={entry}
                              workspaceId={workspaceId}
                              onResume={resume}
                              onResumeWithSkills={resumeWithOptions}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}

        {history.length > 0 && !hasActiveFilters(filters) && (
          <p className="mt-6 text-[11px] text-gray-400 dark:text-white/40">
            {t("sessions.workspaceScopeHint")}
          </p>
        )}
      </div>

      {pendingSkillChoice && (
        <ResumeOptionsDialog
          entry={pendingSkillChoice.entry}
          statuses={pendingSkillChoice.statuses}
          onCancel={() => setPendingSkillChoice(null)}
          onConfirm={({ skillIds, prelaunch }) => {
            const { entry } = pendingSkillChoice;
            setPendingSkillChoice(null);
            openSession(entry, skillIds, prelaunch).catch(console.error);
          }}
        />
      )}

      {pendingResume && (
        <MissingSkillsDialog
          sessionTitle={pendingResume.entry.title ?? pendingResume.entry.agentLabel}
          statuses={pendingResume.statuses}
          onCancel={() => setPendingResume(null)}
          onContinue={() => {
            const { entry } = pendingResume;
            setPendingResume(null);
            // `restore_session_skills` vuelve a resolver el estado de cada skill en el
            // momento de abrir, así que lo que se haya reinstalado en el diálogo entra
            // solo, sin tener que propagar nada desde acá.
            openSession(entry).catch(console.error);
          }}
        />
      )}
    </main>
  );
}
