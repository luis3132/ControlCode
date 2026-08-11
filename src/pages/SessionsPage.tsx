import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ClockIcon, FolderIcon, ChevronDownIcon } from "neogestify-ui-components";
import {
  SessionHistoryEntry,
  SessionSkillStatus,
  useSessionsStore,
} from "../store/sessions";
import { useTabsStore } from "../store/tabs";
import { useAccountsStore } from "../store/accounts";
import { PageHeader } from "../components/common/PageHeader";
import { MissingSkillsDialog } from "../components/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "../components/sessions/ResumeOptionsDialog";
import type { PrelaunchStep } from "../store/prelaunch";
import { SessionRow } from "../components/sessions/SessionRow";
import {
  EMPTY_FILTERS,
  SessionFilterState,
  SessionFilters,
  filterSessions,
  hasActiveFilters,
} from "../components/sessions/SessionFilters";
import { flushPendingSave } from "../store/persistTabs";
import { registerPendingSkillSetup } from "../lib/pendingSkillSetup";

interface OpenTabLocation {
  windowLabel: string;
  tabId: string;
}

/** Sesión que el usuario quiso reabrir pero quedó esperando la decisión sobre skills. */
interface PendingResume {
  entry: SessionHistoryEntry;
  statuses: SessionSkillStatus[];
}

export function SessionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { history, loadHistory, checkSessionSkills, restoreSessionSkills } = useSessionsStore();
  const { workspaceId, addTab } = useTabsStore();
  // Para poder nombrar la cuenta de cada sesión (ver SessionRow): la lista guarda el id,
  // no el nombre, así que sin esto las filas no tendrían con qué resolverlo.
  const loadAccounts = useAccountsStore((s) => s.load);
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
  const [pendingSkillChoice, setPendingSkillChoice] = useState<PendingResume | null>(null);
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

  /**
   * Si esta conversación ya está abierta en este workspace, la enfoca y devuelve `true`.
   *
   * Vive acá y no en cada handler a propósito: antes solo lo consultaba el botón de
   * reanudar directo, así que reanudar desde cualquiera de los diálogos abría un duplicado
   * de una sesión que ya estaba en pantalla.
   */
  const focusIfAlreadyOpen = async (entry: SessionHistoryEntry): Promise<boolean> => {
    const location = await invoke<OpenTabLocation | null>("find_open_tab_for_session", {
      sessionId: entry.sessionId,
      historyId: entry.id,
      workspaceId,
    }).catch(() => null);
    if (!location) return false;

    await invoke("focus_window", { label: location.windowLabel }).catch(console.error);
    await invoke("broadcast_event", {
      event: "cc-focus-tab",
      payload: JSON.stringify({ targetLabel: location.windowLabel, tabId: location.tabId }),
    }).catch(console.error);
    return true;
  };

  /**
   * Abre la tab de verdad. Sin `skillIds` restaura las skills que la sesión tenía al
   * cerrarse (el camino por defecto); con `skillIds` monta exactamente ese set — es lo que
   * eligió el usuario en `ResumeOptionsDialog`, incluida la lista vacía ("abrir sin
   * skills"), que por eso se distingue de `undefined` y no con un `.length`.
   *
   * `prelaunch` sigue la misma regla: `undefined` = la cadena con la que la sesión corría.
   */
  const openSession = async (
    entry: SessionHistoryEntry,
    skillIds?: string[],
    prelaunch?: PrelaunchStep[]
  ) => {
    if (await focusIfAlreadyOpen(entry)) return;

    const tabId = addTab({
      cwd: entry.cwd,
      agent: { id: entry.agentId, label: entry.agentLabel, command: entry.command, available: true },
      sessionId: entry.sessionId ?? undefined,
      // Vincula la tab con la entrada del historial de la que salió: al cerrarla se
      // actualiza ESA entrada en vez de agregar otra copia de la misma sesión.
      historyId: entry.id,
      // Con la MISMA cuenta con la que corría. Sin esto la tab arrancaba con la cuenta
      // principal y el resume no encontraba nada: el transcript vive dentro de la carpeta
      // de la cuenta, no en el home.
      accountId: entry.accountId ?? undefined,
      // Y con los mismos comandos previos: reabrir una sesión tiene que reproducir el
      // entorno en el que se estaba trabajando, no uno pelado. Salvo que se hayan editado
      // en el diálogo de opciones, que es la única oportunidad de cambiarlos (el entorno
      // se hereda al spawnear y no se puede tocar con el agente ya corriendo).
      prelaunch: prelaunch ?? entry.prelaunch,
    });
    navigate("/workspace");

    // Mismo gate que el wizard del "+": los symlinks tienen que estar en disco ANTES de
    // que arranque el agente, porque varios escanean sus skills solo al boot.
    const setup = (async () => {
      await flushPendingSave();
      if (skillIds === undefined) {
        await restoreSessionSkills(entry.id, workspaceId, tabId).catch(console.error);
        return;
      }
      // Mismo scope que usa `restore_session_skills`: la sesión se reabre como una tab
      // puntual, así que todo entra con scope='tab' aunque en su momento viniera del
      // workspace. Best-effort por skill, para que un conflicto de symlink en una no deje
      // la tab sin las demás.
      for (const skillId of skillIds) {
        await invoke("attach_skill", {
          skillId,
          workspaceId,
          scope: "tab",
          tabId,
        }).catch(console.error);
      }
    })();
    registerPendingSkillSetup(tabId, setup);
  };

  /** Reanudar eligiendo antes las skills: se resuelve su estado actual y se abre el diálogo. */
  const handleResumeWithSkills = async (entry: SessionHistoryEntry) => {
    if (await focusIfAlreadyOpen(entry)) return;
    const statuses = await checkSessionSkills(entry.id).catch(() => []);
    setPendingSkillChoice({ entry, statuses });
  };

  const handleResume = async (entry: SessionHistoryEntry) => {
    // Antes de cualquier diálogo: si ya está abierta, esto es un "llevame ahí" y no una
    // reapertura — no tiene sentido preguntar por skills que ya están montadas.
    if (await focusIfAlreadyOpen(entry)) return;

    // Si alguna de las skills que tenía esta sesión ya no está instalada, se avisa ANTES
    // de abrirla: reabrirla sin ellas es una sesión distinta a la que se cerró, y el
    // usuario tiene que poder decidir entre reinstalarlas o seguir igual.
    const statuses = await checkSessionSkills(entry.id).catch(() => []);
    if (statuses.some((s) => !s.installedSkillId)) {
      setPendingResume({ entry, statuses });
      return;
    }

    await openSession(entry);
  };

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
                              onResume={handleResume}
                              onResumeWithSkills={handleResumeWithSkills}
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
