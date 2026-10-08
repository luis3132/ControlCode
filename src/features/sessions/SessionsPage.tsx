import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Button, ClockIcon, EmptyState, Kbd, SearchIcon } from "neogestify-ui-components";

import { useSessionsStore } from "@/features/sessions/store";
import { useTabsStore } from "@/features/tabs/store";
import { useAccountsStore } from "@/features/accounts/store";
import { useRepoInfo } from "@/features/workspaces/useRepoInfo";
import { baseName } from "@/features/workspaces/workspaceTree";
import { MissingSkillsDialog } from "@/features/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "@/features/sessions/ResumeOptionsDialog";
import { SessionRow, type RowAccount } from "@/features/sessions/SessionRow";
import { SessionDetail, SessionDetailEmpty } from "@/features/sessions/SessionDetail";
import { SessionFilters } from "@/features/sessions/SessionFilters";
import { groupSessions, type GroupMode } from "@/features/sessions/sessionGroups";
import type { SessionHistoryEntry } from "@/features/sessions/types";
import { moveSelection, reconcileSelection, useSelectionVisible } from "@/shared/ui/paletteNav";
import {
  EMPTY_FILTERS,
  filterSessions,
  hasActiveFilters,
  type SessionFilterState,
} from "@/features/sessions/filters";

import { useResumeSession } from "./useResumeSession";

const GROUP_KEY = "cc-sessions-group";

function readGroupMode(): GroupMode {
  try {
    return localStorage.getItem(GROUP_KEY) === "project" ? "project" : "date";
  } catch {
    return "date";
  }
}

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
  // Para poder nombrar la cuenta de cada sesión: la lista guarda el id, no el nombre.
  const loadAccounts = useAccountsStore((s) => s.load);
  const accounts = useAccountsStore((s) => s.accounts);
  const accountsLoaded = useAccountsStore((s) => s.loaded);
  const [filters, setFilters] = useState<SessionFilterState>(EMPTY_FILTERS);
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode);
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

  const changeGroupMode = (mode: GroupMode) => {
    setGroupMode(mode);
    try { localStorage.setItem(GROUP_KEY, mode); } catch { /* sin storage: solo esta vez */ }
  };

  // Las carpetas se resuelven contra git sobre el historial ENTERO y no sobre lo filtrado:
  // si no, cada tecla en el buscador cambiaba el conjunto y relanzaba consultas.
  const allCwds = useMemo(() => history.map((e) => e.cwd), [history]);
  const repos = useRepoInfo(allCwds);

  const visible = useMemo(() => filterSessions(history, filters), [history, filters]);
  const groups = useMemo(
    () => groupSessions(groupMode, visible, repos, new Date()),
    [groupMode, visible, repos]
  );
  const order = useMemo(() => groups.flatMap((g) => g.sessions), [groups]);
  const orderIds = useMemo(() => order.map((s) => s.id), [order]);

  // Al escribir, la lista se rehace: lo marcado sobrevive si sigue estando, y si no se
  // marca lo primero.
  useEffect(() => {
    setSelectedId((current) => reconcileSelection(orderIds, current));
  }, [orderIds]);

  const selected = order.find((s) => s.id === selectedId) ?? null;
  const selectedRef = useSelectionVisible<HTMLDivElement>(selectedId);

  // El foco arranca en el buscador: esto se recorre escribiendo, como el marketplace.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountOf = (entry: SessionHistoryEntry): RowAccount => {
    // Mientras no cargaron no se marca nada: si no, todas parecerían de una cuenta borrada.
    if (!entry.accountId || !accountsLoaded) return null;
    const account = accountById.get(entry.accountId);
    return account ? { name: account.name, label: account.label } : "gone";
  };
  const whereOf = (entry: SessionHistoryEntry) => {
    const info = repos.get(entry.cwd);
    return {
      project: baseName(info?.root ?? entry.cwd),
      branch: info?.branch ?? null,
      isWorktree: info?.isWorktree ?? false,
    };
  };

  // Las filas van memoizadas: los callbacks tienen que ser estables o se redibujarían
  // todas en cada render igual. `resume` se rearma en cada render del hook, así que se
  // llama a través de una ref.
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const onResume = useCallback((entry: SessionHistoryEntry) => { resumeRef.current(entry); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedId((current) => moveSelection(orderIds, current, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      if (e.shiftKey) resumeWithOptions(selected);
      else resume(selected);
    }
  };

  const filtered = hasActiveFilters(filters);

  return (
    <div className="@container/page flex flex-col h-full min-h-0">

      {/* ══ encabezado: título, agrupación, buscador y filtros ══════════════════ */}
      <div className="flex flex-col gap-3 shrink-0 px-4 @[640px]/page:px-6 pt-4 @[640px]/page:pt-[18px] pb-3.5
        border-b border-gray-200 dark:border-white/8">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-2.5">
            <h1 className="m-0 text-[18px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-50">
              {t("sidebar.sessions")}
            </h1>
            <span className="text-[12px] tabular-nums text-gray-500 dark:text-white/50">
              {filtered
                ? t("sessions.countFiltered", { shown: visible.length, total: history.length })
                : t("sessions.countAll", { count: history.length })}
            </span>
          </div>
          <div className="flex-1" />
          {history.length > 0 && (
            <div role="group" aria-label={t("sessions.group.label")}
              className="flex items-center gap-0.5 p-[3px] rounded-[9px]
                bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8">
              <span className="hidden @[520px]/page:inline pl-1.5 pr-2 text-[11.5px] text-gray-500 dark:text-white/50">
                {t("sessions.group.label")}
              </span>
              {(["date", "project"] as const).map((mode) => (
                <Button variant="custom"
                  key={mode}
                  onClick={() => changeGroupMode(mode)}
                  aria-pressed={groupMode === mode}
                  className={`cc-t h-[26px] px-2.5 rounded-md text-[12px] font-medium
                    ${groupMode === mode
                      ? "bg-white dark:bg-white/12 text-gray-900 dark:text-gray-50 shadow-sm dark:shadow-none"
                      : "text-gray-500 dark:text-white/60 hover:text-gray-800 dark:hover:text-white"}`}
                >
                  {t(`sessions.group.${mode}`)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2.5 flex-[1_1_320px] min-w-0 h-[38px] px-3 rounded-[10px]
            bg-white dark:bg-[#0a0f16]
            border border-gray-200 dark:border-white/10
            focus-within:border-blue-500/60 dark:focus-within:border-blue-400/45
            focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.12)]">
            <SearchIcon className="w-[15px] h-[15px] shrink-0 text-blue-500 dark:text-blue-400" />
            <span className="sr-only">{t("sessions.filters.search")}</span>
            <input
              ref={inputRef}
              value={filters.query}
              onChange={(e) => setFilters({ ...filters, query: e.target.value })}
              onKeyDown={onKeyDown}
              placeholder={t("sessions.filters.search")}
              className="flex-1 min-w-0 h-full bg-transparent outline-none text-[13.5px]
                text-gray-900 dark:text-white
                placeholder:text-gray-400 dark:placeholder:text-white/40"
            />
          </label>
          {history.length > 0 && (
            <SessionFilters entries={history} value={filters} onChange={setFilters} />
          )}
        </div>
      </div>

      {/* ══ cuerpo: la lista y el detalle de la marcada ══════════════════════════ */}
      {history.length === 0 ? (
        <div className="flex-1 min-h-0 cc-scroll">
          <EmptyState
            className="py-16"
            icon={<ClockIcon className="w-8 h-8" />}
            title={t("sessions.empty")}
            description={t("sessions.emptyHint")}
          />
        </div>
      ) : (
        <div className="@container flex-1 min-h-0">
          <div className="flex flex-col @[860px]:flex-row h-full min-h-0">
            <div className="flex-1 min-h-0 min-w-0 cc-scroll pt-1 pb-4" onKeyDown={onKeyDown} tabIndex={-1}>
              {visible.length === 0 ? (
                <EmptyState
                  className="py-14"
                  icon={<SearchIcon className="w-8 h-8" />}
                  title={t("sessions.noMatches")}
                  action={
                    filtered ? (
                      <Button variant="custom"
                        onClick={() => setFilters(EMPTY_FILTERS)}
                        className="cc-t text-[12px] text-blue-600 dark:text-blue-400 hover:underline inline-block"
                      >
                        {t("sessions.filters.clear")}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                groups.map((group) => (
                  <div key={group.key}>
                    <div className="flex items-center gap-2.5 px-5 pt-4 pb-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em]
                        text-gray-500 dark:text-white/55">
                        {group.bucket ? t(`sessions.bucket.${group.bucket}`) : group.label}
                      </span>
                      {group.sub && (
                        <span className="truncate font-mono text-[11px] text-gray-400 dark:text-white/40">
                          {group.sub}
                        </span>
                      )}
                      <span className="flex-1 h-px bg-gray-200 dark:bg-white/7" />
                      <span className="text-[11px] tabular-nums text-gray-400 dark:text-white/45">
                        {group.sessions.length}
                      </span>
                    </div>
                    {group.sessions.map((entry) => {
                      const where = whereOf(entry);
                      return (
                        <SessionRow
                          key={entry.id}
                          entry={entry}
                          selected={entry.id === selectedId}
                          project={where.project}
                          branch={where.branch}
                          isWorktree={where.isWorktree}
                          account={accountOf(entry)}
                          rowRef={entry.id === selectedId ? selectedRef : undefined}
                          onSelect={setSelectedId}
                          onResume={onResume}
                        />
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <aside
              aria-label={t("sessions.detail.label")}
              className="shrink-0 min-h-0 max-h-[40%] @[860px]:max-h-none @[860px]:w-[min(400px,40%)] cc-scroll
                bg-gray-50 dark:bg-[#0a0f16]
                border-t @[860px]:border-t-0 @[860px]:border-l border-gray-200 dark:border-white/8"
            >
              {selected ? (
                <SessionDetail
                  key={selected.id}
                  entry={selected}
                  {...whereOf(selected)}
                  account={accountOf(selected)}
                  workspaceId={workspaceId}
                  onResume={resume}
                  onResumeWithOptions={resumeWithOptions}
                />
              ) : (
                <SessionDetailEmpty />
              )}
            </aside>
          </div>
        </div>
      )}

      {/* Lo que no entra se esconde entero en vez de partirse en dos líneas. */}
      <div className="flex items-center gap-[18px] h-[34px] shrink-0 px-4 @[640px]/page:px-6
        whitespace-nowrap overflow-hidden
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20
        text-[11px] text-gray-500 dark:text-white/50">
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> {t("sessions.key.resume")}</span>
        <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> {t("sessions.key.move")}</span>
        <span className="hidden @[480px]/page:flex items-center gap-1.5">
          <Kbd>⇧ ↵</Kbd> {t("sessions.key.resumeWithOptions")}
        </span>
        <div className="flex-1" />
        <span className="hidden @[820px]/page:block truncate">{t("sessions.workspaceScopeHint")}</span>
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
