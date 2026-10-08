import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { BranchIcon } from "@/app/icons";
import { agentIcon } from "@/features/agents/agentIcons";
import type { SessionHistoryEntry } from "@/features/sessions/types";

import { formatClosedShort, formatDateTime } from "./sessionFormat";

/** Con qué cuenta corría: `null` = la principal, `"gone"` = una que ya se borró. */
export type RowAccount = { name: string; label: string | null } | "gone" | null;

interface SessionRowProps {
  entry: SessionHistoryEntry;
  selected: boolean;
  /** El nombre del proyecto (el repo, o la carpeta si no está en ninguno). */
  project: string;
  branch: string | null;
  isWorktree: boolean;
  account: RowAccount;
  /** Solo lo recibe la fila MARCADA, para poder traerla a la vista con las flechas. */
  rowRef?: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onResume: (entry: SessionHistoryEntry) => void;
}

/**
 * Una sesión cerrada en la lista.
 *
 * Sin acciones propias: viven en el detalle de la derecha. Antes cada fila montaba cinco
 * botones con tooltip (unos 200 en un historial normal) para mostrar solo los de la fila
 * bajo el mouse — era la mayor parte del costo de entrar a la página. Va memoizada porque
 * marcar otra fila solo tiene que redibujar las dos que cambian.
 */
export const SessionRow = memo(function SessionRow({
  entry, selected, project, branch, isWorktree, account, rowRef, onSelect, onResume,
}: SessionRowProps) {
  const { t } = useTranslation();
  const AgentIcon = agentIcon(entry.agentId, entry.command);

  return (
    <div ref={rowRef} className="mx-2">
      <Button variant="custom"
        tabIndex={-1}
        onClick={() => onSelect(entry.id)}
        onDoubleClick={() => onResume(entry)}
        aria-current={selected || undefined}
        className={`cc-t flex items-center gap-3 w-full min-h-[54px] px-3 py-2 rounded-[10px] text-left
          ${selected
            ? "bg-blue-500/12 dark:bg-blue-400/12 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.35)] dark:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.35)]"
            : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
      >
        <span className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0
          bg-gray-100 dark:bg-white/8 text-gray-600 dark:text-gray-300">
          <AgentIcon className="w-4 h-4" />
        </span>

        <span className="flex flex-col gap-[3px] min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">
            <span className="truncate text-[13px] font-semibold text-gray-900 dark:text-gray-50">
              {entry.title ?? entry.agentLabel}
            </span>
            {/* Solo si NO es la cuenta principal: marcar lo habitual sería ruido en todas
                las filas de todos los que nunca crearon una cuenta. */}
            {account && (
              <span
                title={account === "gone" ? undefined : account.label ?? undefined}
                className={`flex items-center gap-1.5 shrink-0 h-[18px] px-[7px] rounded-full
                  text-[10.5px] font-medium
                  ${account === "gone"
                    ? "bg-orange-500/12 text-orange-700 dark:text-orange-300"
                    : "bg-blue-500/12 text-blue-700 dark:text-blue-300"}`}
              >
                <span className="w-[5px] h-[5px] rounded-full bg-current" />
                {account === "gone" ? t("sessions.account.gone") : account.name}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-gray-500 dark:text-white/55">
            <span className="shrink-0">{entry.agentLabel}</span>
            <span className="shrink-0 opacity-50">·</span>
            <span className="shrink-0 max-w-[16rem] truncate text-gray-600 dark:text-white/70">{project}</span>
            {branch && (
              <span className="flex items-center gap-1 min-w-0">
                <BranchIcon className="w-3 h-3 shrink-0" />
                <span className="truncate font-mono text-[11px]">
                  {isWorktree && `${t("sessions.worktree")} · `}{branch}
                </span>
              </span>
            )}
          </span>
        </span>

        <span
          className="shrink-0 text-[11.5px] tabular-nums text-gray-500 dark:text-white/55"
          title={formatDateTime(entry.closedAt)}
        >
          {formatClosedShort(entry.closedAt)}
        </span>
      </Button>
    </div>
  );
});
