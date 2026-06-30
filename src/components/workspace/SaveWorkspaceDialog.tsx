import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal } from "neogestify-ui-components";
import { useWorkspacesStore } from "../../store/workspaces";

interface SaveWorkspaceDialogProps {
  onClose: () => void;
}

export function SaveWorkspaceDialog({ onClose }: SaveWorkspaceDialogProps) {
  const { t } = useTranslation();
  const saveCurrentAsWorkspace = useWorkspacesStore((s) => s.saveCurrentAsWorkspace);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("workspace.save.error.empty"));
      return;
    }
    setSaving(true);
    try {
      await saveCurrentAsWorkspace(trimmed);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("workspace.save.title")}
      onClose={onClose}
      size="sm"
      closeOnBackdrop
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {t("btn.save")}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        onKeyDown={(e) => e.key === "Enter" && handleSave()}
        placeholder={t("workspace.save.placeholder")}
        variant="outline"
        error={error}
      />
    </Modal>
  );
}
