import { useState } from "react";
import { Modal, Button } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import { FolderPickerStep } from "./FolderPickerStep";
import { AgentPickerStep } from "./AgentPickerStep";
import { SkillPickerStep } from "./SkillPickerStep";
import { AgentInfo, useTabsStore } from "../../store/tabs";
import { useSettingsStore } from "../../store/settings";

type Step = "folder" | "agent" | "skills";

interface NewTabWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (params: { cwd: string; agent: AgentInfo; skillIds: string[] }) => void;
}

export function NewTabWizard({ isOpen, onClose, onConfirm }: NewTabWizardProps) {
  const { t } = useTranslation();
  const { detectedAgents } = useTabsStore();
  const { customAgents } = useSettingsStore();
  const [step, setStep] = useState<Step>("folder");
  const [selectedCwd, setSelectedCwd] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

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
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedCwd || !selectedAgent) return;
    onConfirm({ cwd: selectedCwd, agent: selectedAgent, skillIds: selectedSkillIds });
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
        <AgentPickerStep
          agents={allAgents}
          selected={selectedAgent?.id ?? null}
          onSelect={setSelectedAgent}
        />
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
