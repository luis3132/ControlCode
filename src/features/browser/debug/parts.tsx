import type { ReactNode } from "react";
import { SearchIcon, Tooltip } from "neogestify-ui-components";

/** La fila de controles de arriba de cada pestaña del panel. */
export function PanelToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 h-9 shrink-0 px-2.5 overflow-x-auto
      border-b border-gray-200 dark:border-white/7">
      {children}
    </div>
  );
}

export function FilterChip({ active, onClick, children, tone }: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "error" | "warn";
}) {
  const activeTone = tone === "error"
    ? "bg-red-600 text-white"
    : tone === "warn"
      ? "bg-amber-500 text-white"
      : "bg-gray-800 text-white dark:bg-white dark:text-gray-900";
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`cc-t shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium tabular-nums
        ${active ? activeTone : "text-gray-600 dark:text-white/55 hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
}

export function SearchField({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="relative flex items-center shrink-0 w-44">
      <SearchIcon className="absolute left-2 w-3 h-3 text-gray-400 dark:text-white/30" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full h-6 pl-6 pr-2 rounded-md outline-none text-[11.5px]
          bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10
          focus:border-blue-500 dark:focus:border-blue-400
          text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/30"
      />
    </label>
  );
}

export function IconAction({ label, onClick, children, disabled }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={label} placement="top">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
          text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-transparent"
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function TextAction({ onClick, children, disabled, danger }: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`cc-t shrink-0 h-6 px-2 rounded-md text-[11px] font-medium disabled:opacity-40 disabled:hover:bg-transparent
        ${danger
          ? "text-red-600 dark:text-red-400 hover:bg-red-500/10"
          : "text-gray-600 dark:text-white/55 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"}`}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full min-h-24 px-6 text-center
      text-[11.5px] leading-relaxed text-gray-400 dark:text-white/30">
      {children}
    </div>
  );
}
