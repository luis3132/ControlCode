import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { Button, AlertaToast } from "neogestify-ui-components";
import {
  FolderIcon,
  ArrowRightIcon,
  TrashIcon,
  DocumentIcon,
  ChevronDownIcon,
  StackIcon,
} from "neogestify-ui-components";
import { SessionHistoryEntry, useSessionsStore } from "../../store/sessions";
import { agentIcon } from "../../lib/agentIcons";

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

/** Nombre de archivo sugerido al exportar: legible y sin caracteres problemáticos. */
function suggestedFileName(entry: SessionHistoryEntry): string {
  const base = (entry.title ?? entry.agentLabel)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const date = new Date(entry.closedAt * 1000).toISOString().slice(0, 10);
  return `${base || "sesion"}-${date}.md`;
}

interface SessionRowProps {
  entry: SessionHistoryEntry;
  workspaceId: string;
  onResume: (entry: SessionHistoryEntry) => void;
}

export function SessionRow({ entry, workspaceId, onResume }: SessionRowProps) {
  const { t } = useTranslation();
  const { deleteSession, exportSession } = useSessionsStore();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const AgentIcon = agentIcon(entry.agentId, entry.command);
  const hasDetail = entry.skills.length > 0 || entry.siblingTabs.length > 0;

  const handleExport = async () => {
    const dest = await save({
      title: t("sessions.export.title"),
      defaultPath: suggestedFileName(entry),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!dest) return;
    setBusy(true);
    try {
      await exportSession(entry.id, dest);
      AlertaToast(t("sessions.export.title"), t("sessions.export.done"), "success", 4000);
    } catch (e) {
      AlertaToast(t("sessions.export.title"), String(e), "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t("sessions.delete.confirm"))) return;
    setBusy(true);
    try {
      await deleteSession(entry.id, workspaceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700
      bg-white dark:bg-gray-800/50
      hover:border-gray-300 dark:hover:border-gray-600
      transition-colors">

      <div className="flex items-center gap-3 px-4 py-3">
        <span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg
          bg-gray-100 dark:bg-white/8 text-gray-500 dark:text-gray-400">
          <AgentIcon className="w-4 h-4" />
        </span>

        <div className="flex flex-col min-w-0 gap-1 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold
            text-gray-800 dark:text-gray-100 truncate">
            {entry.title ?? entry.agentLabel}
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0
              bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
              {entry.agentLabel}
            </span>
          </span>
          <span className="flex items-center gap-1 text-xs truncate font-mono
            text-gray-400 dark:text-gray-500">
            <FolderIcon className="w-3 h-3 shrink-0" />
            {entry.cwd}
          </span>
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            {t("sessions.opened", { time: formatDateTime(entry.openedAt) })}
            {" · "}
            {t("sessions.closed", { time: formatRelative(entry.closedAt) })}
          </span>

          {entry.skills.length > 0 && (
            <span className="flex flex-wrap gap-1 mt-0.5">
              {entry.skills.map((s) => (
                <span
                  key={s.name}
                  title={t("sessions.skillScope", { scope: s.scope })}
                  className="text-[10px] px-1.5 py-0.5 rounded-full
                    bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                >
                  {s.name}
                </span>
              ))}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {hasDetail && (
            <Button
              variant="icon"
              onClick={() => setExpanded((v) => !v)}
              title={t("sessions.detail.toggle")}
            >
              <ChevronDownIcon
                className={`w-4 h-4 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
              />
            </Button>
          )}
          <Button variant="icon" disabled={busy} onClick={handleExport} title={t("sessions.export.action")}>
            <DocumentIcon className="w-4 h-4" />
          </Button>
          <Button
            variant="icon"
            disabled={busy}
            onClick={handleDelete}
            title={t("sessions.delete.action")}
            className="hover:text-red-500! dark:hover:text-red-400!"
          >
            <TrashIcon className="w-4 h-4" />
          </Button>
          <Button variant="icon" onClick={() => onResume(entry)} title={t("sessions.resume")}>
            <ArrowRightIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Con qué configuración se estaba trabajando: las skills activas y las otras tabs
          que estaban abiertas en el workspace cuando esta sesión se cerró. */}
      {expanded && hasDetail && (
        <div className="px-4 pb-3 pt-1 ml-11 flex flex-col gap-3
          border-t border-gray-100 dark:border-white/5">

          {entry.skills.length > 0 && (
            <div className="flex flex-col gap-1 mt-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide
                text-gray-400 dark:text-gray-500">
                {t("sessions.detail.skills")}
              </span>
              <ul className="flex flex-col gap-0.5">
                {entry.skills.map((s) => (
                  <li key={s.name} className="text-xs text-gray-600 dark:text-gray-300">
                    {s.name}
                    <span className="text-gray-400 dark:text-gray-500">
                      {" — "}{t("sessions.skillScope", { scope: s.scope })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {entry.siblingTabs.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold
                uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <StackIcon className="w-3 h-3" />
                {t("sessions.detail.siblings")}
              </span>
              <ul className="flex flex-col gap-0.5">
                {entry.siblingTabs.map((s, i) => (
                  <li key={`${s.cwd}-${i}`} className="text-xs text-gray-600 dark:text-gray-300 truncate">
                    {s.title ?? s.agentLabel}
                    <span className="font-mono text-gray-400 dark:text-gray-500">
                      {" — "}{s.cwd}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
