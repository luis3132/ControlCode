import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertaConfirmacion, AlertaToast, Button, IconDownload, Kbd, TrashIcon, WarningIcon,
} from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { usePrelaunchStore } from "@/features/prelaunch/store";
import { stepCommand, stepLabel } from "@/features/prelaunch/types";
import { useSessionsStore } from "@/features/sessions/store";
import type { SessionHistoryEntry, SessionSkillStatus } from "@/features/sessions/types";

import { formatDateTime, formatRelative, suggestedFileName } from "./sessionFormat";
import type { RowAccount } from "./SessionRow";

/** Cuánto esperar antes de preguntar por las skills: recorriendo con las flechas, cada
 *  fila por la que se pasa no tiene por qué disparar una consulta. */
const STATUS_DEBOUNCE_MS = 140;

type SkillState = "ok" | "swap" | "missing" | "checking";

function skillState(status: SessionSkillStatus | undefined): SkillState {
  if (!status) return "checking";
  if (!status.installedSkillId) return "missing";
  return status.substituted ? "swap" : "ok";
}

const DOT: Record<SkillState, string> = {
  ok: "bg-green-500 dark:bg-green-400",
  swap: "bg-yellow-500 dark:bg-yellow-400",
  missing: "bg-orange-500 dark:bg-orange-400",
  checking: "bg-gray-300 dark:bg-white/20",
};

const STATE_TEXT: Record<SkillState, string> = {
  ok: "text-gray-500 dark:text-white/55",
  swap: "text-yellow-700 dark:text-yellow-200",
  missing: "text-orange-700 dark:text-orange-300",
  checking: "text-gray-400 dark:text-white/40",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.06em]
      text-gray-500 dark:text-white/50">
      {children}
    </h3>
  );
}

interface SessionDetailProps {
  entry: SessionHistoryEntry;
  project: string;
  branch: string | null;
  isWorktree: boolean;
  account: RowAccount;
  workspaceId: string;
  onResume: (entry: SessionHistoryEntry) => void;
  onResumeWithOptions: (entry: SessionHistoryEntry) => void;
}

/**
 * Todo lo de la sesión marcada, y lo que se puede hacer con ella.
 *
 * Reemplaza a las acciones por fila y al desplegable de configuración: una sola sesión a la
 * vez se mira en detalle, así que el costo de dibujarlo se paga una vez y no por fila.
 */
export function SessionDetail({
  entry, project, branch, isWorktree, account, workspaceId, onResume, onResumeWithOptions,
}: SessionDetailProps) {
  const { t } = useTranslation();
  const checkSessionSkills = useSessionsStore((s) => s.checkSessionSkills);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const exportSession = useSessionsStore((s) => s.exportSession);
  const presets = usePrelaunchStore((s) => s.presets);
  const presetsLoaded = usePrelaunchStore((s) => s.loaded);
  const loadPresets = usePrelaunchStore((s) => s.load);
  const [busy, setBusy] = useState(false);
  /** El estado actual de las skills archivadas, de la sesión `forId`. */
  const [statuses, setStatuses] = useState<{ forId: string; list: SessionSkillStatus[] } | null>(null);

  useEffect(() => {
    if (entry.prelaunch.length > 0 && !presetsLoaded) loadPresets().catch(console.error);
  }, [entry.prelaunch.length, presetsLoaded, loadPresets]);

  useEffect(() => {
    if (entry.skills.length === 0) return;
    let gone = false;
    const timer = setTimeout(() => {
      checkSessionSkills(entry.id)
        .then((list) => { if (!gone) setStatuses({ forId: entry.id, list }); })
        .catch(console.error);
    }, STATUS_DEBOUNCE_MS);
    return () => { gone = true; clearTimeout(timer); };
  }, [entry.id, entry.skills.length, checkSessionSkills]);

  const current = statuses?.forId === entry.id ? statuses.list : null;
  const statusOf = (name: string) => current?.find((s) => s.name === name);
  const missingCount = current?.filter((s) => !s.installedSkillId).length ?? 0;

  const AgentIcon = agentIcon(entry.agentId, entry.command);

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
    // `window.confirm` nativo desentonaba: en una ventana sin decoración muestra un diálogo
    // del sistema con el título del origen e ignora el tema de la app.
    const answer = await AlertaConfirmacion(t("sessions.delete.action"), t("sessions.delete.confirm"));
    if (!answer.isConfirmed) return;
    setBusy(true);
    try {
      await deleteSession(entry.id, workspaceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex flex-col gap-5 px-[22px] pt-[22px] pb-[18px]">

        <div className="flex items-start gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-[10px] shrink-0
            bg-gray-100 dark:bg-white/8 text-gray-600 dark:text-gray-300">
            <AgentIcon className="w-5 h-5" />
          </span>
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="m-0 text-[15.5px] font-semibold leading-snug text-gray-900 dark:text-gray-50
              [overflow-wrap:anywhere]">
              {entry.title ?? entry.agentLabel}
            </h2>
            <span className="text-[12px] text-gray-500 dark:text-white/55">
              {entry.agentLabel} · {t("sessions.closed", { time: formatRelative(entry.closedAt) })}
            </span>
            <span className="text-[11.5px] text-gray-400 dark:text-white/45">
              {t("sessions.detail.openedAt", { date: formatDateTime(entry.openedAt) })}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="custom"
            onClick={() => onResume(entry)}
            className="cc-t flex-1 flex items-center justify-center gap-2 h-[38px] rounded-[9px]
              bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold"
          >
            {t("sessions.resume")}
            <kbd className="font-mono text-[10.5px] px-[5px] py-px rounded bg-white/20">↵</kbd>
          </Button>
          <Button variant="custom"
            onClick={() => onResumeWithOptions(entry)}
            title={t("sessions.resumeWithSkills")}
            className="cc-t flex items-center gap-2 h-[38px] px-3 rounded-[9px]
              border border-gray-200 dark:border-white/14
              bg-white dark:bg-white/4 hover:bg-gray-50 dark:hover:bg-white/8
              text-gray-800 dark:text-gray-100 text-[12.5px] font-medium"
          >
            {t("sessions.resumeOptionsShort")}
          </Button>
        </div>

        {missingCount > 0 && (
          <div className="flex gap-2.5 px-3 py-[11px] rounded-[9px]
            bg-orange-500/8 border border-orange-500/30">
            <WarningIcon className="w-4 h-4 mt-px shrink-0 text-orange-600 dark:text-orange-300" />
            <span className="text-[12px] leading-[1.45] text-orange-800 dark:text-orange-200">
              {t("sessions.detail.missingWarning", { count: missingCount })}
            </span>
          </div>
        )}

        <section className="flex flex-col gap-2">
          <SectionTitle>{t("sessions.detail.where")}</SectionTitle>
          <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
            <span className="text-gray-500 dark:text-white/50">{t("sessions.detail.project")}</span>
            <span className="text-gray-800 dark:text-gray-100 [overflow-wrap:anywhere]">{project}</span>
            <span className="text-gray-500 dark:text-white/50">{t("sessions.detail.folder")}</span>
            <span className="font-mono text-[11.5px] text-gray-700 dark:text-white/80 break-all">{entry.cwd}</span>
            <span className="text-gray-500 dark:text-white/50">{t("sessions.detail.branch")}</span>
            <span className="font-mono text-[11.5px] text-gray-700 dark:text-white/80 [overflow-wrap:anywhere]">
              {branch ? `${branch}${isWorktree ? ` (${t("sessions.worktree")})` : ""}` : "—"}
            </span>
            <span className="text-gray-500 dark:text-white/50">{t("sessions.detail.account")}</span>
            <span
              title={account && account !== "gone" ? account.label ?? undefined : undefined}
              className={account === "gone"
                ? "text-orange-700 dark:text-orange-300"
                : "text-gray-800 dark:text-gray-100"}
            >
              {account === "gone"
                ? t("sessions.account.gone")
                : account?.name ?? t("sessions.detail.accountMain")}
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>{t("sessions.detail.skills")} · {entry.skills.length}</SectionTitle>
          {entry.skills.length === 0 ? (
            <span className="text-[12.5px] text-gray-500 dark:text-white/50">{t("sessions.detail.noSkills")}</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {entry.skills.map((s) => {
                const state = skillState(current ? statusOf(s.name) : undefined);
                return (
                  <div key={`${s.scope}:${s.name}`} className="flex items-center gap-2.5 h-[30px] px-2.5 rounded-[7px]
                    bg-gray-50 dark:bg-white/3">
                    <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${DOT[state]}`} />
                    <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-gray-800 dark:text-gray-100">
                      {s.name}
                    </span>
                    <span className="text-[11px] text-gray-400 dark:text-white/45">{s.scope}</span>
                    {state !== "checking" && (
                      <span className={`text-[11px] font-medium ${STATE_TEXT[state]}`}>
                        {t(`sessions.detail.skillState.${state}`)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {entry.prelaunch.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("sessions.detail.prelaunch")}</SectionTitle>
            <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg
              bg-gray-50 dark:bg-[#080b0f] border border-gray-200 dark:border-white/7">
              {entry.prelaunch.map((step, i) => {
                const command = stepCommand(step, presets);
                const label = stepLabel(step, presets);
                return (
                  <span key={i} title={label ?? undefined}
                    className="font-mono text-[11.5px] text-gray-700 dark:text-white/80 break-all">
                    <span className="text-gray-400 dark:text-white/40">$ </span>
                    {command ?? t("sessions.detail.presetGone")}
                  </span>
                );
              })}
            </div>
          </section>
        )}

        {entry.siblingTabs.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("sessions.detail.siblings")}</SectionTitle>
            {entry.siblingTabs.map((s, i) => (
              <div key={`${s.cwd}-${i}`} title={s.cwd} className="flex items-center gap-2.5 text-[12.5px]">
                <span className="truncate text-gray-800 dark:text-gray-100">{s.title ?? s.agentLabel}</span>
                <span className="shrink-0 text-[11.5px] text-gray-500 dark:text-white/45">{s.agentLabel}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="flex-1" />
      <div className="flex items-center gap-1 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/8">
        <Button variant="custom"
          onClick={handleExport}
          disabled={busy}
          className="cc-t flex items-center gap-[7px] h-[30px] px-2.5 rounded-[7px] text-[12px]
            text-gray-600 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/6
            disabled:opacity-40"
        >
          <IconDownload className="w-3.5 h-3.5" />
          {t("sessions.export.action")}
        </Button>
        <div className="flex-1" />
        <Button variant="custom"
          onClick={handleDelete}
          disabled={busy}
          className="cc-t flex items-center gap-[7px] h-[30px] px-2.5 rounded-[7px] text-[12px]
            text-red-600 dark:text-red-400 hover:bg-red-500/10
            disabled:opacity-40"
        >
          <TrashIcon className="w-3.5 h-3.5" />
          {t("sessions.delete.action")}
        </Button>
      </div>
    </div>
  );
}

/** Lo que se ve a la derecha cuando no hay nada marcado (la lista vacía o filtrada a cero). */
export function SessionDetailEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 h-full px-8 text-center
      text-[12.5px] text-gray-500 dark:text-white/45">
      <Kbd>↑↓</Kbd>
      {t("sessions.detail.selectHint")}
    </div>
  );
}
