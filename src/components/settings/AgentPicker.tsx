import { agentIcon } from "../../lib/agentIcons";

export interface AgentPickerOption {
  agentId: string;
  label: string;
  /** Línea chica bajo el nombre: el conteo de cuentas, la variable, lo que aplique. */
  hint?: string;
  disabled?: boolean;
}

interface AgentPickerProps {
  options: AgentPickerOption[];
  value: string;
  onChange: (agentId: string) => void;
}

/**
 * Elección de TUI en tarjetas, no en un `<select>`.
 *
 * Es el mismo control que el Home, y a propósito: elegir agente es la misma decisión en
 * los dos lugares, así que se ve igual en los dos. Además son tres o cuatro opciones con
 * logo — desplegar una lista para eso esconde información que entra de sobra en pantalla.
 */
export function AgentPicker({ options, value, onChange }: AgentPickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const isSelected = option.agentId === value;
        const Icon = agentIcon(option.agentId);
        return (
          <button
            key={option.agentId}
            type="button"
            disabled={option.disabled}
            onClick={() => onChange(option.agentId)}
            className={`
              group flex items-center gap-3 px-4 py-3 rounded-xl border text-left
              transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed
              ${isSelected
                ? "border-blue-500 bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-500/10 dark:to-violet-500/10 shadow-sm"
                : "border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-white/[0.02] hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm"}
            `}
          >
            <span className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-lg
              transition-colors duration-200
              ${isSelected
                ? "bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300"
                : "bg-gray-200/70 text-gray-500 dark:bg-white/6 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-200"}`}>
              <Icon className="w-5 h-5" />
            </span>

            <span className="flex flex-col gap-0.5 min-w-0">
              <span className={`text-sm font-semibold truncate transition-colors
                ${isSelected
                  ? "text-blue-700 dark:text-blue-300"
                  : "text-gray-800 dark:text-gray-100 group-hover:text-gray-900 dark:group-hover:text-white"}`}>
                {option.label}
              </span>
              {option.hint && (
                <span className={`text-xs truncate transition-colors
                  ${isSelected
                    ? "text-blue-500/70 dark:text-blue-400/70"
                    : "text-gray-400 dark:text-gray-500"}`}>
                  {option.hint}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
