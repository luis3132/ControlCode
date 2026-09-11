import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FolderIcon, Modal } from "neogestify-ui-components";

import { AgentPickerStep } from "@/features/tabs/wizard/AgentPickerStep";
import { AccountPickerStep } from "@/features/tabs/wizard/AccountPickerStep";
import { AdvancedOptions } from "@/features/tabs/wizard/AdvancedOptions";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import type { AgentInfo } from "@/features/tabs/types";
import type { PrelaunchStep } from "@/features/prelaunch/types";

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

/**
 * Abrir otro agente en el workspace en el que estás.
 *
 * Antes esto era un wizard de tres pasos que empezaba pidiendo la carpeta. Pero el "+" de
 * la barra agrega un agente al workspace ACTUAL, y un workspace es una carpeta: preguntarla
 * otra vez era hacer elegir algo que ya estaba decidido, y encima obligaba a pasar por dos
 * pantallas antes de llegar a lo único que cambia.
 *
 * Queda una sola pantalla con las tres decisiones reales —qué TUI, con qué cuenta, con qué
 * skills— y la carpeta arriba como contexto, para que quede claro dónde va a abrirse.
 *
 * Elegir una carpeta distinta es abrir OTRO workspace, y eso vive en Home.
 */
export function NewAgentDialog({ isOpen, cwd, onClose, onConfirm }: NewAgentDialogProps) {
  const { t } = useTranslation();
  const allAgents = useAvailableAgents();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>();
  const [prelaunch, setPrelaunch] = useState<PrelaunchStep[]>([]);

  // Se limpia al cerrar, no al abrir: si se limpiara al abrir, la elección anterior
  // parpadearía un instante antes de desaparecer.
  useEffect(() => {
    if (isOpen) return;
    setAgent(null);
    setSkillIds([]);
    setAccountId(undefined);
    setPrelaunch([]);
  }, [isOpen]);

  if (!isOpen) return null;

  const confirm = () => {
    if (!agent) return;
    onConfirm({ agent, skillIds, accountId, prelaunch });
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      title={t("newAgent.title")}
      size="md"
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={confirm} disabled={!agent}>
            {t("btn.open")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
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

        <AgentPickerStep
          agents={allAgents}
          selected={agent?.id ?? null}
          onSelect={(next) => {
            setAgent(next);
            // Las cuentas y las skills son por TUI: lo elegido para otra no aplica acá.
            setAccountId(undefined);
            setSkillIds([]);
          }}
        />

        {/* Los dos se dibujan solos según la TUI: el de cuentas se esconde si solo hay una,
            y el de opciones viene plegado. Quien no los use no ve nada de más. */}
        {agent && (
          <AccountPickerStep agentId={agent.id} value={accountId} onChange={setAccountId} />
        )}

        {agent && (
          <SkillPickerStep agentId={agent.id} selected={skillIds} onChange={setSkillIds} />
        )}

        {agent && (
          <AdvancedOptions
            agentCommand={agent.command}
            prelaunch={prelaunch}
            onPrelaunchChange={setPrelaunch}
          />
        )}
      </div>
    </Modal>
  );
}
