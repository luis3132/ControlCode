import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, CheckCircleIcon, ShieldIcon, Tooltip } from "neogestify-ui-components";

import { BellIcon, ProcessIcon } from "@/app/icons";
import { activateItem } from "@/features/tabs/layout/layoutStore";
import { agentKey } from "@/features/tabs/layout/layoutTree";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { unreadCount, useNotificationsStore, type Notice } from "./store";

const KIND = {
  finished: { Icon: CheckCircleIcon, tone: "text-emerald-500" },
  approval: { Icon: ShieldIcon, tone: "text-amber-500" },
  processFailed: { Icon: ProcessIcon, tone: "text-red-500" },
} as const;

/**
 * La campana de la barra de arriba. Abrirla da todo por leído: lo que importa es el punto,
 * que dice "pasó algo desde la última vez que miraste".
 */
export function NotificationBell({ className }: { className: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notices = useNotificationsStore((s) => s.notices);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = unreadCount(notices);

  useEffect(() => {
    if (!open) return;
    markAllRead();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // Lo que llega con la campana abierta también se está viendo.
  }, [open, notices.length, markAllRead]);

  const go = (notice: Notice) => {
    setOpen(false);
    if ("tabId" in notice.target) {
      activateItem(agentKey(notice.target.tabId));
      navigate("/workspace");
    } else {
      navigate(notice.target.path);
    }
  };

  const label = unread > 0 ? t("notifications.unread", { count: unread }) : t("notifications.title");

  return (
    <div className="relative flex items-center" ref={ref} data-tauri-drag-region="false">
      {/* Abierta, el globo taparía el encabezado del panel. */}
      <Tooltip content={label} placement="bottom" disabled={open}>
        <Button variant="icon"
          onClick={() => setOpen((v) => !v)}
          aria-label={label}
          aria-expanded={open}
          className={`${className} relative ${open ? "bg-gray-200/70 dark:bg-white/8 text-gray-700 dark:text-white/80" : ""}`}
        >
          <BellIcon className="w-[15px] h-[15px]" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 w-[7px] h-[7px] rounded-full bg-blue-500
              ring-2 ring-gray-100 dark:ring-[#080b0f]" />
          )}
        </Button>
      </Tooltip>

      {open && (
        <div className="cc-rise absolute top-full right-0 mt-1.5 w-80 z-100 overflow-hidden
          rounded-xl border border-gray-200 dark:border-white/10
          bg-white dark:bg-[#11161f] shadow-2xl">
          <div className="flex items-center h-9 pl-3 pr-1.5 border-b border-gray-200 dark:border-white/8">
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-white/40">
              {t("notifications.title")}
            </span>
            {notices.length > 0 && (
              <Button variant="custom"
                onClick={clear}
                className="cc-t h-6 px-2 rounded-md text-[11px] text-gray-500 dark:text-white/50
                  hover:text-gray-800 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/8"
              >
                {t("notifications.clear")}
              </Button>
            )}
          </div>

          {notices.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-gray-400 dark:text-white/35">{t("notifications.empty")}</p>
          ) : (
            <div className="cc-scroll max-h-80 overflow-y-auto p-1">
              {notices.map((notice) => {
                const { Icon, tone } = KIND[notice.kind];
                return (
                  <Button variant="custom"
                    key={notice.id}
                    onClick={() => go(notice)}
                    className="cc-t flex items-start gap-2.5 w-full px-2.5 py-2 rounded-lg text-left
                      hover:bg-gray-100 dark:hover:bg-white/6"
                  >
                    <Icon className={`w-4 h-4 mt-px shrink-0 ${tone}`} />
                    <span className="flex-1 min-w-0 text-xs leading-snug text-gray-700 dark:text-gray-200">
                      {notice.text}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-gray-400 dark:text-white/35">
                      {elapsed(notice.at)}
                    </span>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
