import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { agentIcon } from "@/features/agents/agentIcons";
import type { AgentPaint } from "@/features/browser/agentPaint";
import type { Tab } from "@/features/tabs/types";
import { useChatActivity, useChatStore } from "@/features/chat/store";
import { useNotificationsStore } from "@/features/notifications/store";
import { formatUptime } from "@/features/processes/types";
import { activeMark, TAB_ACTIVE, TAB_IDLE, TAB_SHELL } from "@/features/tabs/tabStyle";

interface TabItemProps {
  tab: Tab;
  /** La clave de la tab en los grupos: el arrastre la busca por ahí. */
  tabKey: string;
  className?: string;
  /** El color de este agente, si está manejando un navegador. */
  paint?: AgentPaint | null;
  /** Qué dice el tooltip cuando está pintada. */
  paintHint?: string;
  isActive: boolean;
  /** `false` en un grupo sin el foco: la línea de la activa va en gris. */
  groupFocused?: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onRenameCommit: (title: string) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function TabItem({
  tab, tabKey, className = "", paint = null, paintHint, isActive, groupFocused = true,
  onActivate, onClose, onRenameCommit, onPointerDown, onContextMenu,
}: TabItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const AgentIcon = agentIcon(tab.agentId, tab.command);
  const { t } = useTranslation();
  // Con qué cuenta corre, abajo del título. Con varias cuentas de la misma TUI abiertas,
  // es lo único que distingue dos tabs que si no se ven iguales. Sin cuenta elegida corre
  // con la del sistema, y se dice solo si esa TUI tiene otras: si no, no hay nada que
  // distinguir.
  const accounts = useAccountsStore((s) => s.accounts);
  const account = useMemo(() => {
    if (tab.accountId) {
      const a = accounts.find((x) => x.id === tab.accountId);
      return a ? { name: a.name, hint: a.label ?? a.name } : null;
    }
    return accounts.some((x) => x.agentId === tab.agentId) ? { name: null, hint: null } : null;
  }, [accounts, tab.accountId, tab.agentId]);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed) onRenameCommit(trimmed);
    else setEditValue(tab.title);
    setIsEditing(false);
  };

  return (
    <div
      data-tab-key={tabKey}
      onPointerDown={isEditing ? undefined : onPointerDown}
      onClick={onActivate}
      onDoubleClick={(e) => {
        e.preventDefault();
        setEditValue(tab.title);
        setIsEditing(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      title={paintHint}
      className={`${TAB_SHELL} max-w-64 min-w-27 ${className}
        ${paint && !isActive ? paint.tint : ""}
        ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
    >
      {/* El mismo color que el navegador que está manejando: las dos tabs se leen como una. */}
      {paint && <span className={`absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r ${paint.strip}`} />}
      {isActive && <span className={activeMark(groupFocused)} />}

      <AgentIcon className={`w-3.5 h-3.5 shrink-0 opacity-70 ${paint ? paint.ink : ""}`} />

      {/* Título o input de rename */}
      {isEditing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setEditValue(tab.title); setIsEditing(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          className="bg-transparent text-xs outline-none w-full min-w-0
            text-gray-900 dark:text-white"
        />
      ) : (
        <span className="flex items-baseline gap-1.5 flex-1 min-w-0">
          <span className="text-xs truncate">{tab.title}</span>
          {account && (
            <span title={account.hint ?? undefined}
              className="text-[10px] truncate shrink-[2] text-gray-400 dark:text-white/35">
              {account.name ?? t("accounts.system")}
            </span>
          )}
        </span>
      )}

      {tab.mode === "html" ? (
        <ChatStatus tabId={tab.id} />
      ) : (
        // Sin PTY todavía = arrancando. Es lo único que se puede afirmar del estado.
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.ptyId == null ? "bg-amber-500" : "bg-emerald-500"}`} />
      )}

      {/* Cerrar: a la vista en la activa; en las demás, al pasar el mouse. Siempre ocupa su
          lugar, así el ancho de la tab no salta. */}
      <Button variant="icon"
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title={t("btn.close")}
        aria-label={t("btn.close")}
        className={`shrink-0 flex items-center justify-center w-4 h-4 rounded
          text-gray-400 dark:text-gray-500
          hover:text-gray-700 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/15
          transition-opacity duration-100 p-0
          ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </Button>
    </div>
  );
}

/**
 * En modo HTML no hay PTY, pero sí se sabe qué hace el agente: si espera un permiso lo dice
 * con palabras (es lo único que pide algo de vos), si trabaja muestra hace cuánto, y si
 * terminó mientras no lo mirabas queda un punto azul hasta que lo veas.
 */
function ChatStatus({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const activity = useChatActivity(tabId);
  const startedAt = useChatStore((s) => s.chats[tabId]?.startedAt ?? null);
  const finished = useNotificationsStore((s) => tabId in s.finished);

  if (activity === "approval") {
    return (
      <span className="shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-semibold
        bg-amber-500/15 text-amber-700 dark:text-amber-400">
        {t("tabs.status.approval")}
      </span>
    );
  }
  if (activity === "working") {
    return (
      <span className="flex items-center gap-1 shrink-0 font-mono text-[10px] tabular-nums text-gray-400 dark:text-white/45"
        title={t("tabs.status.working")}>
        <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-emerald-500/25 border-t-emerald-500 animate-spin" />
        {startedAt !== null && <Since at={startedAt} />}
      </span>
    );
  }
  if (finished) {
    return <span title={t("tabs.status.finished")} className="w-1.5 h-1.5 rounded-full shrink-0 bg-blue-500" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" />;
}

/** "42s", "3m 05s": el reloj del turno en curso, que se mueve solo mientras se muestra. */
function Since({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatUptime(now - at)}</>;
}
