import { useState, useRef, useEffect } from "react";

import { agentIcon } from "@/features/agents/agentIcons";
import type { AgentPaint } from "@/features/browser/agentPaint";
import type { Tab } from "@/features/tabs/types";

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
      className={`
        group relative flex items-center gap-2 h-10 pl-3 pr-1.5 shrink-0
        max-w-48 min-w-27 rounded-t-[9px] cursor-pointer select-none
        transition-colors duration-150 ${className}
        ${paint && !isActive ? paint.tint : ""}
        ${isActive
          ? "bg-gray-50 dark:bg-[#0d1117] text-gray-900 dark:text-white"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-200/50 dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-200"}
      `}
    >
      {/* El mismo color que el navegador que está manejando: las dos tabs se leen como una. */}
      {paint && <span className={`absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r ${paint.strip}`} />}
      {/* La tab activa se funde con el área de abajo; la línea la remata. */}
      {isActive && (
        <span className={`absolute bottom-0 left-0 right-0 h-[2px] ${groupFocused ? "bg-blue-500" : "bg-gray-300 dark:bg-white/20"}`} />
      )}

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
        <span className="text-xs truncate flex-1 min-w-0">{tab.title}</span>
      )}

      {/* Sin PTY todavía = arrancando. Es lo único que se puede afirmar del estado. */}
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 transition-opacity
          ${tab.ptyId == null ? "bg-amber-500" : "bg-emerald-500"}
          group-hover:opacity-0`}
      />

      {/* Botón cerrar — siempre visible pero sutil, hover lo destaca */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Cerrar"
        className="
          absolute right-1.5 shrink-0 flex items-center justify-center
          w-4 h-4 rounded
          text-gray-400 dark:text-gray-600
          opacity-0 group-hover:opacity-100
          hover:text-gray-700 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/15
          transition-opacity duration-100
        "
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
