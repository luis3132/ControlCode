import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { Button, CloseIcon } from "neogestify-ui-components";

import { buildPreview } from "./PermissionCard";
import { useRunsStore } from "./store";
import type { PendingApproval } from "./types";

/** Líneas del diff que entran en el aviso; el resto se ve en la consola. */
const TOAST_DIFF_LINES = 4;

/** Los pedidos nuevos: los que no estaban en la lista anterior. */
export function newApprovalIds(previous: Set<string>, current: PendingApproval[]): string[] {
  return current.filter((a) => !previous.has(a.id)).map((a) => a.id);
}

/**
 * El aviso de que un agente de la flota está esperando un permiso, en la esquina.
 *
 * Existe porque el pedido se queda parado sin que nada lo diga: estás en una terminal, el
 * chip de la barra de estado es chico, y el agente espera. Esto se ve desde cualquier
 * pantalla, y se puede contestar ahí mismo.
 *
 * - En la consola de la flota no aparece: ahí ya están las tarjetas de permiso.
 * - Cerrarlo lo esconde hasta que llegue un pedido nuevo; los pendientes siguen en el
 *   globo del riel y en la barra de estado.
 * - Sin atajos de teclado a propósito: `y`/`n` globales se dispararían mientras alguien
 *   escribe en una terminal. Los atajos viven en la consola, donde el foco es de la tarjeta.
 * - Si la ventana no tiene el foco, se le pide atención al sistema (la barra de tareas
 *   parpadea o el Dock salta): un agente parado en segundo plano no debería depender de
 *   que alguien mire.
 */
export function ApprovalToast() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const approvals = useRunsStore((s) => s.approvals);
  const tasks = useRunsStore((s) => s.tasks);
  const decideApproval = useRunsStore((s) => s.decideApproval);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seen = useRef<Set<string>>(new Set());

  // Un pedido nuevo vuelve a mostrar el aviso y, sin foco, pide atención.
  useEffect(() => {
    const fresh = newApprovalIds(seen.current, approvals);
    seen.current = new Set(approvals.map((a) => a.id));
    if (fresh.length === 0) return;
    if (!document.hasFocus()) {
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
    }
  }, [approvals]);

  // Lo más viejo primero: es lo que lleva más tiempo parado.
  const pending = useMemo(
    () => [...approvals].sort((a, b) => a.askedAt - b.askedAt),
    [approvals]
  );
  const visible = pending.filter((a) => !dismissed.has(a.id));
  const current = visible[0];
  const preview = useMemo(
    () => (current ? buildPreview(current.toolName, current.input) : null),
    [current]
  );

  if (!current || !preview || pathname.startsWith("/fleet")) return null;

  const task = tasks.find((tk) => tk.id === current.taskId);
  const others = pending.length - 1;

  const decide = async (allow: boolean) => {
    setBusy(true);
    setError("");
    try {
      await decideApproval(current.id, allow, false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-label={t("fleet.toast.title")}
      className="cc-rise w-[360px] max-w-[calc(100vw-2rem)] rounded-xl shadow-2xl overflow-hidden
        border border-amber-300/70 dark:border-amber-500/30 bg-white dark:bg-[#11161d]"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3">
        <span className="relative flex w-2 h-2 mt-1.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-amber-500 animate-ping opacity-60" />
          <span className="relative w-2 h-2 rounded-full bg-amber-500" />
        </span>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] font-semibold text-gray-900 dark:text-white">
            {t("fleet.toast.title")}
          </span>
          <span className="truncate text-[11px] text-gray-500 dark:text-white/45" title={task?.title}>
            {task ? t("fleet.toast.task", { task: task.title, agent: task.agentId }) : t("fleet.toast.unknownTask")}
          </span>
        </div>
        <Button variant="icon"
          onClick={() => setDismissed(new Set(pending.map((a) => a.id)))}
          aria-label={t("btn.close")}
          title={t("fleet.toast.dismiss")}
          className="cc-t flex items-center justify-center w-6 h-6 rounded-md text-gray-400 dark:text-white/40
            hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 p-0"
        >
          <CloseIcon className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 px-4 pt-2.5">
        <span className="truncate font-mono text-[11px] text-amber-800 dark:text-amber-300/90">{preview.title}</span>
        {preview.diff.length > 0 && (
          <div className="flex flex-col rounded-md overflow-hidden bg-gray-50 dark:bg-black/25">
            {preview.diff.slice(0, TOAST_DIFF_LINES).map((line, i) => (
              <span
                key={i}
                className={`overflow-hidden text-ellipsis whitespace-pre [tab-size:2] px-1.5 font-mono text-[10px] leading-[1.45]
                  ${line.sign === "-"
                    ? "bg-red-500/10 text-red-700 dark:text-red-300"
                    : line.sign === "+"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "text-gray-600 dark:text-white/50"}`}
              >
                <span className="select-none opacity-50">{line.sign} </span>
                {line.text || " "}
              </span>
            ))}
          </div>
        )}
        {preview.literal && (
          <span className="line-clamp-2 px-1.5 py-1 rounded-md font-mono text-[10.5px] leading-relaxed
            bg-gray-50 dark:bg-black/25 text-gray-700 dark:text-white/65">
            {preview.literal}
          </span>
        )}
        {error && <p className="text-[11px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex items-center gap-1.5 px-4 py-3">
        <Button variant="custom"
          onClick={() => navigate("/fleet")}
          className="mr-auto text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline inline-block"
        >
          {others > 0 ? t("fleet.toast.openMore", { count: others }) : t("fleet.toast.open")}
        </Button>
        <Button variant="custom"
          onClick={() => void decide(false)}
          disabled={busy}
          className="cc-t h-7 px-3 rounded-md text-[11.5px] font-medium text-gray-600 dark:text-white/60
            hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 inline-block"
        >
          {t("fleet.permission.deny")}
        </Button>
        <Button variant="custom"
          onClick={() => void decide(true)}
          disabled={busy}
          className="cc-t h-7 px-3 rounded-md text-[11.5px] font-semibold
            bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-block"
        >
          {t("fleet.permission.allow")}
        </Button>
      </div>
    </div>
  );
}
