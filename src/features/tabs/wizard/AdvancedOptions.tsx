import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon } from "neogestify-ui-components";
import { PrelaunchChain } from "@/features/prelaunch/PrelaunchChain";
import type { PrelaunchStep } from "@/features/prelaunch/store";

interface AdvancedOptionsProps {
  agentCommand: string;
  prelaunch: PrelaunchStep[];
  onPrelaunchChange: (steps: PrelaunchStep[]) => void;
}

/**
 * Bloque plegable con lo que no hace falta para abrir una tab normal.
 *
 * Arranca cerrado porque abrir una tab es lo que más se hace en la app y la mayoría de los
 * proyectos no necesitan preparar nada. Pero si ya hay una cadena armada se abre solo: un
 * bloque cerrado que esconde comandos que SÍ se van a ejecutar sería justo el tipo de
 * sorpresa que esta feature intenta evitar.
 */
export function AdvancedOptions({
  agentCommand,
  prelaunch,
  onPrelaunchChange,
}: AdvancedOptionsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(prelaunch.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start text-[11px] font-semibold
          uppercase tracking-widest text-gray-400 dark:text-gray-500
          hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <ChevronDownIcon
          className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        {t("wizard.advanced")}
        {!open && prelaunch.length > 0 && (
          <span className="normal-case tracking-normal px-1.5 py-0.5 rounded-full
            bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[10px]">
            {t("prelaunch.stepCount", { count: prelaunch.length })}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 pl-5">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("prelaunch.chainDesc")}
          </p>
          <PrelaunchChain
            value={prelaunch}
            onChange={onPrelaunchChange}
            agentCommand={agentCommand}
          />
        </div>
      )}
    </div>
  );
}
