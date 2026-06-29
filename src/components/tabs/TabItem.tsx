import { useState, useRef, useEffect } from "react";
import { CloseIcon } from "neogestify-ui-components";
import { Tab } from "../../store/tabs";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  isDragOver: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onRenameCommit: (title: string) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}

export function TabItem({
  tab, isActive, isDragOver,
  onActivate, onClose, onRenameCommit,
  onDragStart, onDragOver, onDrop,
}: TabItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);

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
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onActivate}
      onDoubleClick={(e) => { e.preventDefault(); setEditValue(tab.title); setIsEditing(true); }}
      className={`
        group relative flex items-center gap-1.5 h-9 px-3 shrink-0 max-w-44 min-w-20
        border-r cursor-pointer select-none transition-colors
        border-gray-200 dark:border-white/10
        ${isActive
          ? "bg-white dark:bg-[#0d1117] text-gray-900 dark:text-white"
          : "bg-gray-100 dark:bg-[#161b22] text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white/70"}
        ${isDragOver ? "border-l-2 border-l-blue-500" : ""}
      `}
    >
      {isActive && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
      )}

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
        <span className="text-xs truncate flex-1">{tab.title}</span>
      )}

      <button
        onClick={onClose}
        className="shrink-0 opacity-0 group-hover:opacity-40 hover:opacity-80! transition-opacity
          text-gray-600 dark:text-white"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
