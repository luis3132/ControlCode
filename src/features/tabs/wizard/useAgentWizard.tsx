import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FolderIcon, Progress } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import { useSkillsStore } from "@/features/skills/store";
import { AgentPickerStep } from "@/features/tabs/wizard/AgentPickerStep";
import { AccountPickerStep, useAgentAccounts } from "@/features/tabs/wizard/AccountPickerStep";
import { AdvancedOptions } from "@/features/tabs/wizard/AdvancedOptions";
import { FolderStep } from "@/features/tabs/wizard/FolderStep";
import { PrelaunchChain } from "@/features/prelaunch/PrelaunchChain";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import type { PrelaunchStep } from "@/features/prelaunch/types";

export interface WizardResult {
  cwd: string;
  agent: AgentInfo;
  skillIds: string[];
  /** `undefined` = la cuenta del sistema. */
  accountId?: string;
  prelaunch: PrelaunchStep[];
}

type StepId = "folder" | "agent" | "account" | "skills" | "prelaunch";

/**
 * Abrir un agente, un paso por vez. Lo usan el modal del "+" (`NewAgentDialog`) y la
 * página de Inicio: los dos piden lo mismo, y el hook devuelve el cuerpo y el pie para que
 * cada uno los ponga donde le toca.
 *
 * Es un wizard y no un formulario largo porque las decisiones dependen unas de otras: sin
 * TUI elegida no se sabe qué cuentas hay ni qué skills son compatibles. Mostrarlas todas
 * juntas obligaba a leer de arriba abajo una pantalla donde la mitad todavía no aplicaba.
 *
 * **Los pasos no son fijos**: el de carpeta aparece solo si no viene decidida (`cwd`), y el
 * de cuenta solo si esa TUI tiene más de una, así que la barra de abajo puede decir "de 2"
 * o "de 4". Es preferible a un paso que siempre está y que la mayoría de las veces tiene una
 * sola respuesta posible.
 *
 * Elegir la carpeta o la TUI avanza solo: son pasos de una sola decisión, y quedarse ahí
 * esperando un click en "Siguiente" es un trámite.
 *
 * **La terminal pelada no es un agente**: no tiene skills que elegir, así que después de
 * elegirla solo quedan los comandos previos (activar un venv, un `nvm use`), a la vista y
 * no plegados —son lo único del paso— y "Abrir".
 */
export function useAgentWizard({
  active, cwd: fixedCwd, initialSkillIds, initialPrelaunch, onCancel, onConfirm,
}: {
  /** Mientras es `false` se limpia: el modal cerrado no guarda la elección anterior. */
  active: boolean;
  /** La carpeta, si ya está decidida. Sin ella, el primer paso es elegirla. */
  cwd?: string;
  /** Al duplicar una tab: sus skills vienen marcadas en cualquier TUI que se elija (las
   *  que esa TUI soporta), y sus comandos previos también. */
  initialSkillIds?: string[];
  initialPrelaunch?: PrelaunchStep[];
  /** "Cancelar" en el primer paso. Sin él, el primer paso no ofrece salida (Inicio). */
  onCancel?: () => void;
  onConfirm: (result: WizardResult) => void;
}) {
  const { t } = useTranslation();
  const allAgents = useAvailableAgents();
  const pickFolder = fixedCwd === undefined;
  const first: StepId = pickFolder ? "folder" : "agent";
  const [folder, setFolder] = useState("");
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>();
  const [prelaunch, setPrelaunch] = useState<PrelaunchStep[]>([]);
  const [step, setStep] = useState<StepId>(first);
  const cwd = fixedCwd ?? folder.trim();

  // Las cuentas de la TUI elegida se miran desde acá —y no solo adentro del paso— porque
  // deciden si ese paso existe: con una sola cuenta no hay nada que elegir. Se piden
  // cargadas desde que el asistente está activo porque la respuesta hace falta en el mismo
  // instante en que se elige la TUI, para saber a qué paso saltar.
  const accounts = useAgentAccounts(agent?.id ?? null, active);

  // Se limpia al cerrar, no al abrir: si se limpiara al abrir, la elección anterior
  // parpadearía un instante antes de desaparecer. El paso sí se fija al abrir: el mismo
  // modal se abre con la carpeta decidida o para elegirla, y el primer paso cambia.
  useEffect(() => {
    if (active) {
      setStep(first);
      if (initialPrelaunch) setPrelaunch(initialPrelaunch);
      return;
    }
    setFolder("");
    setAgent(null);
    setSkillIds([]);
    setAccountId(undefined);
    setPrelaunch([]);
    setStep(first);
  }, [active]);

  const isShell = agent?.id === SHELL_AGENT_ID;
  const steps = useMemo<StepId[]>(() => {
    const last: StepId = isShell ? "prelaunch" : "skills";
    const tail: StepId[] = accounts.length > 0 ? ["agent", "account", last] : ["agent", last];
    return pickFolder ? ["folder", ...tail] : tail;
  }, [accounts.length, isShell, pickFolder]);

  // Cambiar de TUI puede borrar el paso donde estabas parado (la nueva no tiene cuentas).
  useEffect(() => {
    if (!steps.includes(step)) setStep("agent");
  }, [steps, step]);

  const index = Math.max(0, steps.indexOf(step));
  const isLast = index === steps.length - 1;
  const canAdvance = step === "folder" ? cwd !== "" : agent !== null;

  const LABELS: Record<StepId, string> = {
    folder: t("newAgent.step.folder"),
    agent: t("newAgent.step.agent"),
    account: t("newAgent.step.account"),
    skills: t("newAgent.step.skills"),
    prelaunch: t("newAgent.step.prelaunch"),
  };

  const go = (delta: number) => {
    const next = steps[index + delta];
    if (next) setStep(next);
  };

  const confirm = () => {
    if (!agent || !cwd) return;
    onConfirm({ cwd, agent, skillIds, accountId, prelaunch });
  };

  const body = (
    <div className="flex flex-col gap-4">
      {/* La carpeta es contexto, no una decisión: por eso se muestra y no se edita. Cuando
          se eligió en el primer paso, para cambiarla se vuelve atrás. */}
      {step !== "folder" && cwd && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg
          bg-gray-100 dark:bg-white/4
          border border-gray-200 dark:border-white/8">
          <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
          <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400"
            dir="rtl" title={cwd}>
            {cwd}
          </span>
        </div>
      )}

      <span className="text-[11px] font-semibold uppercase tracking-widest
        text-gray-400 dark:text-white/35">
        {index + 1} · {LABELS[step]}
      </span>

      {/* Alto mínimo para que el marco no cambie de tamaño entre un paso de dos tarjetas y
          el catálogo de skills: un marco que salta distrae de lo que hay adentro. */}
      <div className="min-h-72">
        {step === "folder" && (
          <FolderStep
            value={folder}
            onChange={setFolder}
            onPicked={(picked) => {
              setFolder(picked);
              setStep("agent");
            }}
          />
        )}

        {step === "agent" && (
          <AgentPickerStep
            agents={allAgents}
            selected={agent?.id ?? null}
            onSelect={(next) => {
              setAgent(next);
              // Las cuentas y las skills son por TUI: lo elegido para otra no aplica acá.
              // Al duplicar, se arranca de las de la tab original que esta TUI soporta.
              setAccountId(undefined);
              const skills = useSkillsStore.getState().skills;
              setSkillIds((initialSkillIds ?? []).filter((id) => {
                const skill = skills.find((x) => x.id === id);
                return skill !== undefined
                  && (skill.compatibleAgents.length === 0 || skill.compatibleAgents.includes(next.id));
              }));
              // Un paso de una sola decisión se cierra al tomarla. A qué paso se salta se le
              // pregunta al store y no al estado de arriba: ese todavía tiene las cuentas de
              // la TUI anterior hasta el próximo render.
              const hasAccounts = useAccountsStore.getState()
                .accounts.some((a) => a.agentId === next.id);
              setStep(hasAccounts ? "account" : next.id === SHELL_AGENT_ID ? "prelaunch" : "skills");
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

        {step === "prelaunch" && agent && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t("newAgent.shellPrelaunchDesc")}
            </p>
            <PrelaunchChain value={prelaunch} onChange={setPrelaunch} agentCommand={agent.command} />
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
  );

  const footer = (
    <div className="flex-1 flex flex-col gap-2.5 min-w-0">
      <Progress
        value={index + 1}
        max={steps.length}
        size="xs"
        variant="accent"
        // Por defecto el lector de pantalla canta el porcentaje, que acá no significa nada:
        // lo que importa es en qué paso estás y cuántos quedan.
        valueText={t("newAgent.progress", { n: index + 1, total: steps.length })}
      />
      <div className="flex items-center gap-3">
        {/* Cuál es el paso ya lo dice el título de arriba; acá va cuántos son, que es lo
            que la barra sola no puede decir. */}
        <span className="min-w-0 truncate text-[11px] text-gray-400 dark:text-white/35">
          {t("newAgent.progress", { n: index + 1, total: steps.length })}
        </span>
        <div className="flex-1" />
        {/* Atrás y Cancelar comparten el lugar: en el primer paso no hay dónde volver, y
            dejar un botón muerto ahí es peor que ofrecer la salida. */}
        {(index > 0 || onCancel) && (
          <Button variant="ghost" onClick={index === 0 ? onCancel : () => go(-1)}>
            {index === 0 ? t("btn.cancel") : t("btn.back")}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={isLast ? confirm : () => go(1)}
          disabled={!canAdvance}
        >
          {isLast ? t("btn.open") : t("btn.next")}
        </Button>
      </div>
    </div>
  );

  return { body, footer };
}
