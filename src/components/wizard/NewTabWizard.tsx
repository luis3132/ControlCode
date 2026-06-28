import { useState } from "react";
import { Modal, Button } from "neogestify-ui-components";
import { FolderPickerStep } from "./FolderPickerStep";
import { AgentPickerStep } from "./AgentPickerStep";
import { AgentInfo, useTabsStore } from "../../store/tabs";
import { useSettingsStore } from "../../store/settings";

type Step = "folder" | "agent";

interface NewTabWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (params: { cwd: string; agent: AgentInfo }) => void;
}

export function NewTabWizard({ isOpen, onClose, onConfirm }: NewTabWizardProps) {
  const { detectedAgents } = useTabsStore();
  const { customAgents } = useSettingsStore();
  const [step, setStep] = useState<Step>("folder");
  const [selectedCwd, setSelectedCwd] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);

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
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleConfirm = () => {
    if (!selectedCwd || !selectedAgent) return;
    onConfirm({ cwd: selectedCwd, agent: selectedAgent });
    reset();
    onClose();
  };

  if (!isOpen) return null;

  const footer =
    step === "folder" ? (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={handleClose}>Cancelar</Button>
        <Button variant="primary" onClick={() => setStep("agent")} disabled={!selectedCwd}>
          Siguiente →
        </Button>
      </div>
    ) : (
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={() => setStep("folder")}>← Atrás</Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleClose}>Cancelar</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!selectedAgent}>
            Abrir
          </Button>
        </div>
      </div>
    );

  return (
    <Modal
      onClose={handleClose}
      title={step === "folder" ? "Seleccionar carpeta" : "Seleccionar agente"}
      size="md"
      footer={footer}
      closeOnBackdrop={false}
    >
      {step === "folder" ? (
        <FolderPickerStep initialPath={selectedCwd} onPathChange={setSelectedCwd} />
      ) : (
        <AgentPickerStep
          agents={allAgents}
          selected={selectedAgent?.id ?? null}
          onSelect={setSelectedAgent}
        />
      )}
    </Modal>
  );
}
