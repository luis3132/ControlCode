import { useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertaConfirmacion,
  AlertaToast,
  ArrowRightIcon,
  Badge,
  ChevronDownIcon,
  DocumentIcon,
  StackIcon,
  Tooltip,
  TrashIcon,
} from "neogestify-ui-components";

import { useSessionsStore } from "@/features/sessions/store";
import type { SessionHistoryEntry } from "@/features/sessions/types";
import { useAccountsStore } from "@/features/accounts/store";
import { agentIcon } from "@/features/agents/agentIcons";

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

/** Botón de acción de la fila: aparece con el hover o con la fila marcada. */
function RowAction({ label, onClick, danger, disabled, children }: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={disabled}
        aria-label={label}
        className={`cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
          text-gray-400 dark:text-white/35
          hover:bg-gray-200 dark:hover:bg-white/10
          disabled:opacity-40 disabled:hover:bg-transparent
          ${danger
            ? "hover:text-red-500 dark:hover:text-red-400"
            : "hover:text-gray-700 dark:hover:text-white"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

interface SessionRowProps {
  entry: SessionHistoryEntry;
  workspaceId: string;
  selected: boolean;
  /** Solo lo recibe la fila MARCADA, para poder traerla a la vista con las flechas. */
  rowRef?: React.RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onResume: (entry: SessionHistoryEntry) => void;
  /** Reabrir eligiendo antes con qué skills montar la TUI. */
  onResumeWithSkills: (entry: SessionHistoryEntry) => void;
}

export function SessionRow({
  entry, workspaceId, selected, rowRef, onSelect, onResume, onResumeWithSkills,
}: SessionRowProps) {
  const { t } = useTranslation();
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const exportSession = useSessionsStore((s) => s.exportSession);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const AgentIcon = agentIcon(entry.agentId, entry.command);
  // Con qué cuenta corría. Importa mostrarlo: dos sesiones del mismo agente en la misma
  // carpeta pueden ser de cuentas distintas, y al reabrirla vuelve a la suya — si eso no se
  // ve, el resultado parece arbitrario. `undefined` = la cuenta ya no existe.
  const accountsLoaded = useAccountsStore((s) => s.loaded);
  const account = useAccountsStore((s) =>
    entry.accountId ? s.accounts.find((a) => a.id === entry.accountId) : undefined
  );
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
    // `window.confirm` nativo desentonaba: en una ventana sin decoración muestra un diálogo
    // del sistema con el título del origen, ignora el tema de la app y no se parece en nada
    // al resto de las confirmaciones. La librería ya trae la versión estilada.
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
    <div className="mx-1.5">
      <div
        ref={rowRef}
        onClick={onSelect}
        onDoubleClick={() => onResume(entry)}
        className={`cc-t group flex items-center gap-2.5 h-[42px] px-2.5 rounded-lg cursor-pointer
          ${selected
            ? "bg-blue-500/12 dark:bg-blue-400/13 shadow-[inset_0_0_0_1px_rgba(88,166,255,0.24)]"
            : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
      >
        <span className="flex items-center justify-center w-6 h-6 rounded-md shrink-0
          bg-gray-100 dark:bg-white/8 text-gray-500 dark:text-gray-400">
          <AgentIcon className="w-3.5 h-3.5" />
        </span>

        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
              {entry.title ?? entry.agentLabel}
            </span>
            {/* Solo si NO es la cuenta principal: marcar lo habitual sería ruido en todas
                las filas de todos los que nunca crearon una cuenta. */}
            {entry.accountId && accountsLoaded && (
              <Tooltip content={account?.label ?? ""} placement="bottom">
                <Badge variant={account ? "accent" : "warning"} size="sm" dot className="shrink-0">
                  {account ? account.name : t("sessions.account.gone")}
                </Badge>
              </Tooltip>
            )}
          </span>
          <span className="flex items-center gap-1.5 min-w-0 text-[10.5px]
            text-gray-400 dark:text-white/35">
            <span className="shrink-0 font-mono">{entry.agentLabel}</span>
            {entry.skills.length > 0 && (
              <>
                <span className="shrink-0 opacity-50">·</span>
                <span className="shrink-0">
                  {t("sessions.skillCount", { n: entry.skills.length })}
                </span>
              </>
            )}
            <span className="shrink-0 opacity-50">·</span>
            <span className="truncate" title={formatDateTime(entry.openedAt)}>
              {t("sessions.closed", { time: formatRelative(entry.closedAt) })}
            </span>
          </span>
        </span>

        {/* Las acciones aparecen con el hover o con la fila marcada: cinco iconos por fila
            en una lista larga son más ruido que ayuda cuando no estás mirando esa fila. */}
        <span className={`cc-t flex items-center gap-0.5 shrink-0
          ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          {hasDetail && (
            <RowAction
              label={t("sessions.detail.toggle")}
              onClick={() => setExpanded((v) => !v)}
            >
              <ChevronDownIcon
                className={`w-3.5 h-3.5 transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
              />
            </RowAction>
          )}
          <RowAction label={t("sessions.export.action")} onClick={handleExport} disabled={busy}>
            <DocumentIcon className="w-3.5 h-3.5" />
          </RowAction>
          <RowAction label={t("sessions.delete.action")} onClick={handleDelete} disabled={busy} danger>
            <TrashIcon className="w-3.5 h-3.5" />
          </RowAction>
          {/* Reanudar ajustando las skills. Va pegado al de reanudar porque son la misma
              acción con distinto grado de control, no dos cosas distintas. */}
          <RowAction label={t("sessions.resumeWithSkills")} onClick={() => onResumeWithSkills(entry)}>
            <StackIcon className="w-3.5 h-3.5" />
          </RowAction>
          <RowAction label={t("sessions.resume")} onClick={() => onResume(entry)}>
            <ArrowRightIcon className="w-3.5 h-3.5" />
          </RowAction>
        </span>
      </div>

      {/* Con qué configuración se estaba trabajando: las skills activas y las otras tabs
          que estaban abiertas en el workspace cuando esta sesión se cerró. */}
      {expanded && hasDetail && (
        <div className="cc-fade flex flex-col gap-2.5 ml-8 mr-2.5 mt-0.5 mb-1.5 pl-3 py-2
          border-l border-gray-200 dark:border-white/8">

          {entry.skills.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                text-gray-400 dark:text-white/30">
                {t("sessions.detail.skills")}
              </span>
              {entry.skills.map((s) => (
                <span key={s.name} className="text-[11.5px] text-gray-600 dark:text-gray-400">
                  {s.name}
                  <span className="text-gray-400 dark:text-white/30">
                    {" — "}{t("sessions.skillScope", { scope: s.scope })}
                  </span>
                </span>
              ))}
            </div>
          )}

          {entry.siblingTabs.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                text-gray-400 dark:text-white/30">
                {t("sessions.detail.siblings")}
              </span>
              {entry.siblingTabs.map((s, i) => (
                <span key={`${s.cwd}-${i}`} className="truncate text-[11.5px]
                  text-gray-600 dark:text-gray-400">
                  {s.title ?? s.agentLabel}
                  <span className="font-mono text-gray-400 dark:text-white/30">
                    {" — "}{s.cwd}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
