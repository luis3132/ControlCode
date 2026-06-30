import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";
import { useWorkspacesStore } from "../../store/workspaces";

interface ResetDefaultDialogProps {
  onClose: () => void;
}

/** Advertencia antes de "Nuevo workspace": el bucket default tiene tabs sin guardar y se perderían. */
export function ResetDefaultDialog({ onClose }: ResetDefaultDialogProps) {
  const { t } = useTranslation();
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await resetDefaultWorkspace();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("workspace.resetDefault.title")}
      onClose={onClose}
      size="sm"
      closeOnBackdrop
      closeOnEsc
      variant="danger"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={handleConfirm}>
            {t("workspace.resetDefault.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t("workspace.resetDefault.body")}
      </p>
    </Modal>
  );
}
