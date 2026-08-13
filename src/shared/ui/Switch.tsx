interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  disabled?: boolean;
}

/** La librería de componentes no trae un toggle — un `<input type="checkbox">` desnudo
 * desentona con el resto de la UI (botones/badges redondeados, sin bordes de sistema). */
export function Switch({ checked, onChange, title, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full
        transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed
        ${checked ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-300 dark:bg-white/15"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm
          transition-transform duration-200
          ${checked ? "translate-x-6" : "translate-x-1"}`}
      />
    </button>
  );
}
