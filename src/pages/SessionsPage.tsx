import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "neogestify-ui-components";
import { FolderIcon, ArrowRightIcon, ClockIcon } from "neogestify-ui-components";
import {
  SessionHistoryEntry,
  SessionSkillStatus,
  useSessionsStore,
} from "../store/sessions";
import { useTabsStore } from "../store/tabs";
import { PageHeader } from "../components/common/PageHeader";
import { MissingSkillsDialog } from "../components/sessions/MissingSkillsDialog";
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

function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRelative(unixSeconds: number): string {
  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const units: [number, string][] = [
    [60, "s"], [60, "m"], [24, "h"], [30, "d"], [12, "mo"], [Infinity, "y"],
  ];
  let value = diffSeconds;
  let unit = "s";
  for (const [size, label] of units) {
    if (value < size) { unit = label; break; }
    value = Math.floor(value / size);
    unit = label;
  }
  return `${value}${unit}`;
}

export function SessionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { history, loadHistory, checkSessionSkills, restoreSessionSkills } = useSessionsStore();
  const { workspaceId, addTab } = useTabsStore();
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);

  useEffect(() => {
    loadHistory(workspaceId);
    // Otra ventana del mismo workspace pudo haber cerrado una tab mientras esta página
    // estaba abierta — mismo patrón de refresco que Home/Workspaces.
    const unlisten = listen("cc-workspace-changed", () => loadHistory(workspaceId));
    return () => { unlisten.then((fn) => fn()); };
  }, [workspaceId, loadHistory]);

  /** Abre la tab de verdad y le restaura las skills que la sesión tenía al cerrarse. */
  const openSession = (entry: SessionHistoryEntry) => {
    const tabId = addTab({
      cwd: entry.cwd,
      agent: { id: entry.agentId, label: entry.agentLabel, command: entry.command, available: true },
      sessionId: entry.sessionId ?? undefined,
      // Vincula la tab con la entrada del historial de la que salió: al cerrarla se
      // actualiza ESA entrada en vez de agregar otra copia de la misma sesión.
      historyId: entry.id,
    });
    navigate("/workspace");

    // Mismo gate que el wizard del "+": los symlinks tienen que estar en disco ANTES de
    // que arranque el agente, porque varios escanean sus skills solo al boot.
    const setup = (async () => {
      await flushPendingSave();
      await restoreSessionSkills(entry.id, workspaceId, tabId).catch(console.error);
    })();
    registerPendingSkillSetup(tabId, setup);
  };

  const handleResume = async (entry: SessionHistoryEntry) => {
    // Si esta conversación ya está abierta en alguna ventana viva de este workspace,
    // enfocar esa tab en vez de abrir un duplicado.
    if (entry.sessionId) {
      const location = await invoke<OpenTabLocation | null>("find_open_tab_for_session", {
        sessionId: entry.sessionId,
        workspaceId,
      }).catch(() => null);

      if (location) {
        await invoke("focus_window", { label: location.windowLabel }).catch(console.error);
        await invoke("broadcast_event", {
          event: "cc-focus-tab",
          payload: JSON.stringify({ targetLabel: location.windowLabel, tabId: location.tabId }),
        }).catch(console.error);
        return;
      }
    }

    // Si alguna de las skills que tenía esta sesión ya no está instalada, se avisa ANTES
    // de abrirla: reabrirla sin ellas es una sesión distinta a la que se cerró, y el
    // usuario tiene que poder decidir entre reinstalarlas o seguir igual.
    const statuses = await checkSessionSkills(entry.id).catch(() => []);
    if (statuses.some((s) => !s.installedSkillId)) {
      setPendingResume({ entry, statuses });
      return;
    }

    openSession(entry);
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
          <div className="flex flex-col gap-2">
            {history.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 px-4 py-3
                  rounded-lg border border-gray-200 dark:border-gray-700
                  bg-white dark:bg-gray-800/50
                  hover:border-gray-300 dark:hover:border-gray-600
                  transition-colors"
              >
                <div className="flex flex-col min-w-0 gap-1 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                    {entry.title ?? entry.agentLabel}
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 shrink-0">
                      {entry.agentLabel}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 truncate font-mono">
                    <FolderIcon className="w-3 h-3 shrink-0" />
                    {entry.cwd}
                  </span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t("sessions.opened", { time: formatDateTime(entry.openedAt) })}
                  </span>
                  {entry.skills.length > 0 && (
                    <span className="flex flex-wrap gap-1 mt-0.5">
                      {entry.skills.map((s) => (
                        <span key={s.name} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                          {s.name}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t("sessions.closed", { time: formatRelative(entry.closedAt) })}
                  </span>
                  <Button
                    variant="icon"
                    onClick={() => handleResume(entry)}
                    title={t("sessions.resume")}
                  >
                    <ArrowRightIcon className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

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
            openSession(entry);
          }}
        />
      )}
    </main>
  );
}
