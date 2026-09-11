import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";
import type { AgentInfo } from "@/features/tabs/types";

interface AgentPickerStepProps {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (agent: AgentInfo) => void;
}

/**
 * Con qué TUI abrir la tab.
 *
 * Las tarjetas son las de Home, literalmente: esta lista tenía una piel propia —un borde
 * de color distinto por agente, y blancos fijos que solo se veían bien en modo oscuro—
 * mientras que Home dibujaba la MISMA decisión con el lenguaje del resto de la app. Eran
 * dos pantallas para elegir lo mismo que no se parecían en nada, así que quedó una y Home
 * la usa.
 *
 * El logo de la TUI es el mismo que después identifica la tab en la barra: la elección de
 * acá y lo que se ve arriba después tienen que poder reconocerse entre sí.
 */
export function AgentPickerStep({ agents, selected, onSelect }: AgentPickerStepProps) {
  const { t } = useTranslation();
  const available = agents.filter((a) => a.available);

  if (available.length === 0) {
    return (
      <p className="text-xs italic text-gray-400 dark:text-white/30">
        {t("wizard.step2.detecting")}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {available.map((agent) => {
        const isSelected = agent.id === selected;
        const AgentIcon = agentIcon(agent.id, agent.command);
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent)}
            aria-pressed={isSelected}
            className={`
              group flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left
              transition-colors duration-200
              ${isSelected
                ? "border-blue-500 bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-500/10 dark:to-violet-500/10 shadow-sm"
                : "border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] hover:border-gray-300 dark:hover:border-white/20 hover:shadow-sm"}
            `}
          >
            <span className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-lg
              transition-colors duration-200
              ${isSelected
                ? "bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300"
                : "bg-gray-200/70 text-gray-500 dark:bg-white/6 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-200"}`}>
              <AgentIcon className="w-5 h-5" />
            </span>

            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate text-[12.5px] font-semibold transition-colors
                  ${isSelected
                    ? "text-blue-700 dark:text-blue-300"
                    : "text-gray-800 dark:text-gray-100 group-hover:text-gray-900 dark:group-hover:text-white"}`}>
                  {agent.label}
                </span>
                {agent.isCustom && (
                  <span className="shrink-0 px-1 rounded text-[9.5px]
                    bg-violet-500/12 text-violet-600 dark:text-violet-400">
                    {t("wizard.step2.customBadge")}
                  </span>
                )}
              </span>
              <span className={`truncate font-mono text-[10.5px] transition-colors
                ${isSelected
                  ? "text-blue-500/70 dark:text-blue-400/70"
                  : "text-gray-400 dark:text-white/35"}`}>
                {agent.command}
              </span>
              {agent.version && (
                <span className="truncate text-[10px] text-emerald-600 dark:text-emerald-400/80">
                  {agent.version}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
