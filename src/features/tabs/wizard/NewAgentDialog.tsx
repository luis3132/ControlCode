import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FolderIcon, Progress } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { AgentPickerStep } from "@/features/tabs/wizard/AgentPickerStep";
import { AccountPickerStep, useAgentAccounts } from "@/features/tabs/wizard/AccountPickerStep";
import { AdvancedOptions } from "@/features/tabs/wizard/AdvancedOptions";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import type { AgentInfo } from "@/features/tabs/types";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { AppDialog } from "@/shared/ui/AppDialog";

interface NewAgentDialogProps {
  isOpen: boolean;
  /** La carpeta del workspace donde va a abrirse. No se elige acá: ya está decidida. */
  cwd: string;
  onClose: () => void;
  onConfirm: (params: {
    agent: AgentInfo;
    skillIds: string[];
    /** `undefined` = la cuenta del sistema. */
    accountId?: string;
    prelaunch: PrelaunchStep[];
  }) => void;
}

type StepId = "agent" | "account" | "skills";

/**
 * Abrir otro agente en el workspace en el que estás, un paso por vez.
 *
 * Es un wizard y no un formulario largo porque las decisiones dependen unas de otras: sin
 * TUI elegida no se sabe qué cuentas hay ni qué skills son compatibles. Mostrarlas todas
 * juntas obligaba a leer de arriba abajo una pantalla donde la mitad todavía no aplicaba.
 *
 * **Los pasos no son fijos**: el de cuenta aparece solo si esa TUI tiene más de una, así
 * que la barra de abajo puede decir "de 2" o "de 3". Es preferible a un paso que siempre
 * está y que la mayoría de las veces tiene una sola respuesta posible.
 *
 * Elegir la TUI avanza solo: es un paso de una sola decisión, y quedarse ahí esperando un
 * click en "Siguiente" es un trámite. Con eso, abrir un agente con lo de siempre son dos
 * clicks —el logo y "Abrir"—, que es lo que costaba antes de que esto fuera un wizard.
 *
 * La carpeta no se decide acá: el "+" agrega un agente al workspace ACTUAL, y un workspace
 * es una carpeta. Por eso va arriba como contexto. Abrir otra es abrir otro workspace, y
 * eso vive en Home.
 */
export function NewAgentDialog({ isOpen, cwd, onClose, onConfirm }: NewAgentDialogProps) {
  const { t } = useTranslation();
  const allAgents = useAvailableAgents();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>();
  const [prelaunch, setPrelaunch] = useState<PrelaunchStep[]>([]);
  const [step, setStep] = useState<StepId>("agent");

  // Las cuentas de la TUI elegida se miran desde acá —y no solo adentro del paso— porque
  // deciden si ese paso existe: con una sola cuenta no hay nada que elegir. Se piden
  // cargadas desde que el diálogo se abre (`isOpen`) porque la respuesta hace falta en el
  // mismo instante en que se elige la TUI, para saber a qué paso saltar.
  const accounts = useAgentAccounts(agent?.id ?? null, isOpen);

  // Se limpia al cerrar, no al abrir: si se limpiara al abrir, la elección anterior
  // parpadearía un instante antes de desaparecer.
  useEffect(() => {
    if (isOpen) return;
    setAgent(null);
    setSkillIds([]);
    setAccountId(undefined);
    setPrelaunch([]);
    setStep("agent");
  }, [isOpen]);

  const steps = useMemo<StepId[]>(
    () => (accounts.length > 0 ? ["agent", "account", "skills"] : ["agent", "skills"]),
    [accounts.length]
  );

  // Cambiar de TUI puede borrar el paso donde estabas parado (la nueva no tiene cuentas).
  useEffect(() => {
    if (!steps.includes(step)) setStep("agent");
  }, [steps, step]);

  const index = Math.max(0, steps.indexOf(step));
  const isLast = index === steps.length - 1;

  const LABELS: Record<StepId, string> = {
    agent: t("newAgent.step.agent"),
    account: t("newAgent.step.account"),
    skills: t("newAgent.step.skills"),
  };

  if (!isOpen) return null;

  const go = (delta: number) => {
    const next = steps[index + delta];
    if (next) setStep(next);
  };

  const confirm = () => {
    if (!agent) return;
    onConfirm({ agent, skillIds, accountId, prelaunch });
    onClose();
  };

  return (
    <AppDialog
      onClose={onClose}
      title={t("newAgent.title")}
      size="lg"
      closeOnBackdrop={false}
      footer={
        // El footer de la librería es una fila alineada a la derecha: con `flex-1` este
        // bloque se queda con todo el ancho y la barra puede cruzarlo entera.
        <div className="flex-1 flex flex-col gap-2.5 min-w-0">
          <Progress
            value={index + 1}
            max={steps.length}
            size="xs"
            variant="accent"
            // Por defecto el lector de pantalla canta el porcentaje, que acá no significa
            // nada: lo que importa es en qué paso estás y cuántos quedan.
            valueText={t("newAgent.progress", { n: index + 1, total: steps.length })}
          />
          <div className="flex items-center gap-3">
            {/* Cuál es el paso ya lo dice el título de arriba; acá va cuántos son, que es
                lo que la barra sola no puede decir. */}
            <span className="min-w-0 truncate text-[11px] text-gray-400 dark:text-white/35">
              {t("newAgent.progress", { n: index + 1, total: steps.length })}
            </span>
            <div className="flex-1" />
            {/* Atrás y Cancelar comparten el lugar: en el primer paso no hay dónde volver,
                y dejar un botón muerto ahí es peor que ofrecer la salida. */}
            <Button variant="ghost" onClick={index === 0 ? onClose : () => go(-1)}>
              {index === 0 ? t("btn.cancel") : t("btn.back")}
            </Button>
            <Button
              variant="primary"
              onClick={isLast ? confirm : () => go(1)}
              disabled={!agent}
            >
              {isLast ? t("btn.open") : t("btn.next")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* La carpeta es contexto, no una decisión: por eso se muestra y no se edita. */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg
          bg-gray-100 dark:bg-white/4
          border border-gray-200 dark:border-white/8">
          <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
          <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400"
            dir="rtl" title={cwd}>
            {cwd}
          </span>
        </div>

        <span className="text-[11px] font-semibold uppercase tracking-widest
          text-gray-400 dark:text-white/35">
          {index + 1} · {LABELS[step]}
        </span>

        {/* Alto mínimo para que el diálogo no cambie de tamaño entre un paso de dos
            tarjetas y el catálogo de skills: un marco que salta distrae de lo que hay
            adentro. */}
        <div className="min-h-72">
          {step === "agent" && (
            <AgentPickerStep
              agents={allAgents}
              selected={agent?.id ?? null}
              onSelect={(next) => {
                setAgent(next);
                // Las cuentas y las skills son por TUI: lo elegido para otra no aplica acá.
                setAccountId(undefined);
                setSkillIds([]);
                // Un paso de una sola decisión se cierra al tomarla. A qué paso se salta
                // se le pregunta al store y no al estado de arriba: ese todavía tiene las
                // cuentas de la TUI anterior hasta el próximo render.
                const hasAccounts = useAccountsStore.getState()
                  .accounts.some((a) => a.agentId === next.id);
                setStep(hasAccounts ? "account" : "skills");
              }}
            />
          )}

          {step === "account" && agent && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-gray-400 dark:text-white/40">
                {t("accounts.pickHint")}
              </p>
              <AccountPickerStep
                agentId={agent.id}
                value={accountId}
                onChange={setAccountId}
                showLabel={false}
              />
            </div>
          )}

          {step === "skills" && agent && (
            <div className="flex flex-col gap-5">
              <SkillPickerStep agentId={agent.id} selected={skillIds} onChange={setSkillIds} />
              {/* Los comandos previos van acá, plegados: son de este lanzamiento y hay que
                  decidirlos antes de arrancar, pero la mayoría de las tabs no los usa y no
                  merecen un paso propio en el que casi siempre se apretaría "Siguiente". */}
              <AdvancedOptions
                agentCommand={agent.command}
                prelaunch={prelaunch}
                onPrelaunchChange={setPrelaunch}
              />
            </div>
          )}
        </div>
      </div>
    </AppDialog>
  );
}
