import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { agentTile, agentVendor } from "@/features/agents/agentTile";
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
          <Button variant="custom"
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent)}
            aria-pressed={isSelected}
            title={agent.version ?? undefined}
            className={`
              group relative flex items-center gap-3 h-16 px-3.5 rounded-[10px] border text-left
              transition-colors duration-200
              ${isSelected
                ? "border-accent-500 bg-accent-500/10 dark:bg-accent-500/16"
                : "border-transparent bg-black/[0.04] dark:bg-surface-raised hover:bg-black/[0.06] dark:hover:bg-surface-overlay"}
            `}
          >
            {/* El color de la marca: se reconoce el agente antes de leer el nombre. */}
            <span className="shrink-0 flex items-center justify-center w-[30px] h-[30px] rounded-lg text-white
              shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)]"
              style={{ background: agentTile(agent.id) }}>
              <AgentIcon className="w-4 h-4" />
            </span>
            {isSelected && (
              <span aria-hidden className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-accent-500 text-white">
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 6.2 2.3 2.3 4.7-4.9" /></svg>
              </span>
            )}

            <span className="flex flex-col min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-[13.5px] leading-[18px] font-semibold text-gray-900 dark:text-gray-50">
                  {agent.label}
                </span>
                {agent.isCustom && (
                  <span className="shrink-0 px-1 rounded text-[9.5px]
                    bg-violet-500/12 text-violet-600 dark:text-violet-400">
                    {t("wizard.step2.customBadge")}
                  </span>
                )}
              </span>
              <span className="truncate text-[11px] leading-[14px] text-gray-500 dark:text-white/60">
                {agentVendor(agent.id, agent.command, t)}
              </span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
