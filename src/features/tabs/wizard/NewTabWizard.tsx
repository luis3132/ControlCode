import { useState } from "react";
import { Modal, Button } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import { FolderPickerStep } from "@/features/tabs/wizard/FolderPickerStep";
import { AgentPickerStep } from "@/features/tabs/wizard/AgentPickerStep";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import { AccountPickerStep } from "@/features/tabs/wizard/AccountPickerStep";
import { AdvancedOptions } from "@/features/tabs/wizard/AdvancedOptions";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { useTabsStore } from "@/features/tabs/store";
import type { AgentInfo } from "@/features/tabs/types";
import { useAgentsStore } from "@/features/agents/store";

type Step = "folder" | "agent" | "skills";

interface NewTabWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (params: {
    cwd: string;
    agent: AgentInfo;
    skillIds: string[];
    /** `undefined` = la cuenta del sistema. */
    accountId?: string;
    /** Comandos que corren antes del agente. Vacío = ninguno. */
    prelaunch: PrelaunchStep[];
  }) => void;
}

export function NewTabWizard({ isOpen, onClose, onConfirm }: NewTabWizardProps) {
  const { t } = useTranslation();
  const { detectedAgents } = useTabsStore();
  const { customAgents } = useAgentsStore();
  const [step, setStep] = useState<Step>("folder");
  const [selectedCwd, setSelectedCwd] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>();
  const [prelaunch, setPrelaunch] = useState<PrelaunchStep[]>([]);

  const allAgents: AgentInfo[] = [
    ...detectedAgents,
    ...customAgents.map((ca) => ({
      id: ca.id,
      label: ca.label,
      command: ca.command,
      available: true,
      isCustom: true,
    })),
  ];

  const reset = () => {
    setStep("folder");
    setSelectedCwd("");
    setSelectedAgent(null);
    setSelectedSkillIds([]);
    setSelectedAccountId(undefined);
    setPrelaunch([]);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedCwd || !selectedAgent) return;
    onConfirm({
      cwd: selectedCwd,
      agent: selectedAgent,
      skillIds: selectedSkillIds,
      accountId: selectedAccountId,
      prelaunch,
    });
    reset();
    onClose();
  };

  if (!isOpen) return null;

  const titleByStep: Record<Step, string> = {
    folder: t("wizard.step1.title"),
    agent: t("wizard.step2.title"),
    skills: t("wizard.step3.title"),
  };

  const footer =
    step === "folder" ? (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={handleClose}>{t("btn.cancel")}</Button>
        <Button variant="primary" onClick={() => setStep("agent")} disabled={!selectedCwd}>
          {t("btn.next")}
        </Button>
      </div>
    ) : step === "agent" ? (
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={() => setStep("folder")}>{t("btn.back")}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={() => setStep("skills")} disabled={!selectedAgent}>
            {t("btn.next")}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={() => setStep("agent")}>{t("btn.back")}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" onClick={handleConfirm}>
            {t("btn.open")}
          </Button>
        </div>
      </div>
    );

  return (
    <Modal
      onClose={handleClose}
      title={titleByStep[step]}
      size="md"
      footer={footer}
      closeOnBackdrop={false}
    >
      {step === "folder" ? (
        <FolderPickerStep initialPath={selectedCwd} onPathChange={setSelectedCwd} />
      ) : step === "agent" ? (
        <div className="flex flex-col gap-5">
          <AgentPickerStep
            agents={allAgents}
            selected={selectedAgent?.id ?? null}
            onSelect={(agent) => {
              setSelectedAgent(agent);
              // Las cuentas son por TUI: la elegida para otra no aplica acá.
              setSelectedAccountId(undefined);
            }}
          />
          {/* Solo aparece si esta TUI tiene más de una cuenta (ver AccountPickerStep), así
              que el wizard sigue siendo de tres pasos para quien no usa cuentas. */}
          {selectedAgent && (
            <AccountPickerStep
              agentId={selectedAgent.id}
              value={selectedAccountId}
              onChange={setSelectedAccountId}
            />
          )}
          {selectedAgent && (
            <AdvancedOptions
              agentCommand={selectedAgent.command}
              prelaunch={prelaunch}
              onPrelaunchChange={setPrelaunch}
            />
          )}
        </div>
      ) : (
        <SkillPickerStep
          agentId={selectedAgent?.id ?? ""}
          selected={selectedSkillIds}
          onChange={setSelectedSkillIds}
        />
      )}
    </Modal>
  );
}
