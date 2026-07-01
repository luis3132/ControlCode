import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "neogestify-ui-components";
import { BackIcon, FolderIcon, ArrowRightIcon } from "neogestify-ui-components";
import { useSessionsStore } from "../store/sessions";
import { useTabsStore } from "../store/tabs";

interface OpenTabLocation {
  windowLabel: string;
  tabId: string;
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
  const { history, loadHistory } = useSessionsStore();
  const { workspaceId, addTab } = useTabsStore();

  useEffect(() => {
    loadHistory(workspaceId);
    // Otra ventana del mismo workspace pudo haber cerrado una tab mientras esta página
    // estaba abierta — mismo patrón de refresco que Home/Workspaces.
    const unlisten = listen("cc-workspace-changed", () => loadHistory(workspaceId));
    return () => { unlisten.then((fn) => fn()); };
  }, [workspaceId, loadHistory]);

  const handleResume = async (entry: (typeof history)[number]) => {
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

    addTab({
      cwd: entry.cwd,
      agent: { id: entry.agentId, label: entry.agentLabel, command: entry.command, available: true },
      sessionId: entry.sessionId ?? undefined,
    });
    navigate("/workspace");
  };

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">

        <div className="flex items-center gap-3 mb-10">
          <Button variant="icon" onClick={() => navigate("/")} title={t("btn.back")}>
            <BackIcon className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {t("sessions.title")}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("sessions.subtitle")}
            </p>
          </div>
        </div>

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
                        <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                          {s}
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
    </main>
  );
}
