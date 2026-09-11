import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  EmptyState,
  Kbd,
} from "neogestify-ui-components";

import { useSessionsStore } from "@/features/sessions/store";
import { useTabsStore } from "@/features/tabs/store";
import { useAccountsStore } from "@/features/accounts/store";
import { useRepoInfo } from "@/features/workspaces/useRepoInfo";
import { BranchIcon } from "@/app/icons";
import { MissingSkillsDialog } from "@/features/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "@/features/sessions/ResumeOptionsDialog";
import { SessionRow } from "@/features/sessions/SessionRow";
import { SessionFilters } from "@/features/sessions/SessionFilters";
import { buildSessionTree, flatSessionOrder } from "@/features/sessions/sessionTree";
import { moveSelection, reconcileSelection, useSelectionVisible } from "@/shared/ui/paletteNav";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadAccounts().catch(console.error); }, [loadAccounts]);

  useEffect(() => {
    loadHistory(workspaceId);
    // Otra ventana del mismo workspace pudo haber cerrado una tab mientras esta página
    // estaba abierta — mismo patrón de refresco que Home/Workspaces.
    const unlisten = listen("cc-workspace-changed", () => loadHistory(workspaceId));
    return () => { unlisten.then((fn) => fn()); };
  }, [workspaceId, loadHistory]);

  const visible = useMemo(() => filterSessions(history, filters), [history, filters]);

  // Las carpetas del historial se resuelven contra git igual que las del panel: es lo que
  // permite agrupar dos worktrees del mismo proyecto juntos en vez de como cosas sueltas.
  const repos = useRepoInfo(useMemo(() => visible.map((e) => e.cwd), [visible]));
  const groups = useMemo(() => buildSessionTree(visible, repos), [visible, repos]);

  // Solo lo que está DESPLEGADO se puede recorrer con las flechas: saltar a una fila que
  // no se ve equivale a actuar a ciegas.
  const order = useMemo(
    () => flatSessionOrder(
      groups.map((g) => ({
        ...g,
        workspaces: g.workspaces.map((w) =>
          collapsed.has(w.key) ? { ...w, sessions: [] } : w
        ),
      }))
    ),
    [groups, collapsed]
  );

  // Al escribir, la lista se rehace: lo marcado sobrevive si sigue estando, y si no se
  // marca lo primero.
  useEffect(() => {
    setSelectedId((current) => reconcileSelection(order.map((s) => s.id), current));
  }, [order]);

  const selected = order.find((s) => s.id === selectedId) ?? null;
  const selectedRef = useSelectionVisible<HTMLDivElement>(selectedId);

  // El foco arranca en el buscador: esto se recorre escribiendo, como el marketplace.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedId((current) =>
        moveSelection(order.map((s) => s.id), current, e.key === "ArrowDown" ? 1 : -1)
      );
      return;
    }
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      resume(selected);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ══ el buscador ═══════════════════════════════════════════════════ */}
      <div className="flex items-center gap-3 h-[54px] shrink-0 px-4
        border-b border-gray-200 dark:border-white/8">
        <ClockIcon className="w-[15px] h-[15px] shrink-0 text-blue-500 dark:text-blue-400" />
        <input
          ref={inputRef}
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder={t("sessions.filters.search")}
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[15px]
            text-gray-900 dark:text-white
            placeholder:text-gray-400 dark:placeholder:text-white/25"
        />
        <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
          {t("sessions.filters.results", { count: visible.length })}
        </span>
      </div>

      {history.length > 0 && (
        <SessionFilters
          entries={history}
          value={filters}
          onChange={setFilters}
          resultCount={visible.length}
        />
      )}

      {/* ══ el árbol: repo → carpeta → sesiones ═══════════════════════════ */}
      <div className="flex-1 min-h-0 cc-scroll py-1.5" onKeyDown={onKeyDown} tabIndex={-1}>
        {history.length === 0 ? (
          <EmptyState
            className="py-14"
            icon={<ClockIcon className="w-8 h-8" />}
            title={t("sessions.empty")}
            description={t("sessions.workspaceScopeHint")}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            className="py-14"
            icon={<ClockIcon className="w-8 h-8" />}
            title={t("sessions.noMatches")}
            action={
              hasActiveFilters(filters) ? (
                <button
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="cc-t text-[11.5px] text-blue-500 dark:text-blue-400 hover:underline"
                >
                  {t("sessions.filters.clear")}
                </button>
              ) : undefined
            }
          />
        ) : (
          groups.map((group) => (
            <div key={group.key} className="mt-2 first:mt-0">
              {/* El repo, como eyebrow: agrupa pero no compite con las filas. */}
              <div className="flex items-center gap-2.5 px-4 pt-1 pb-1">
                <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                  text-gray-400 dark:text-white/30">
                  {group.name}
                </span>
                <span className="flex-1 h-px bg-gray-200 dark:bg-white/6" />
                <span className="text-[9.5px] tabular-nums text-gray-400 dark:text-white/25">
                  {group.sessionCount}
                </span>
              </div>

              {group.workspaces.map((ws) => {
                const isCollapsed = collapsed.has(ws.key);
                return (
                  <div key={ws.key}>
                    <button
                      onClick={() => toggleGroup(ws.key)}
                      title={ws.cwd}
                      className="cc-t flex items-center gap-2 h-7 w-full px-4 text-left
                        hover:bg-gray-100 dark:hover:bg-white/4"
                    >
                      {isCollapsed
                        ? <ChevronRightIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/35" />
                        : <ChevronDownIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/35" />}
                      {/* La rama es lo que distingue dos copias del mismo repo; el nombre
                          de la carpeta va detrás, atenuado, para ubicarla en el disco. */}
                      <BranchIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/30" />
                      <span className="shrink-0 max-w-[14rem] truncate text-[11.5px] font-semibold
                        text-gray-700 dark:text-gray-300">
                        {ws.title}
                      </span>
                      <span className="min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/30">
                        {ws.subtitle}
                      </span>
                      <span className="flex-1" />
                      <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
                        {ws.sessions.length}
                      </span>
                    </button>

                    {!isCollapsed && ws.sessions.map((entry) => (
                      <SessionRow
                        key={entry.id}
                        entry={entry}
                        workspaceId={workspaceId}
                        selected={entry.id === selectedId}
                        rowRef={entry.id === selectedId ? selectedRef : undefined}
                        onSelect={() => setSelectedId(entry.id)}
                        onResume={resume}
                        onResumeWithSkills={resumeWithOptions}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20
        text-[10.5px] text-gray-400 dark:text-white/35">
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> {t("sessions.key.resume")}</span>
        <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> {t("sessions.key.move")}</span>
        <div className="flex-1" />
        <span className="truncate">{t("sessions.workspaceScopeHint")}</span>
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
    </div>
  );
}
