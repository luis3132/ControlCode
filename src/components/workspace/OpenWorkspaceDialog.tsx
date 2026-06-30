import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";
import { useWorkspacesStore, WorkspaceSummary } from "../../store/workspaces";

interface OpenWorkspaceDialogProps {
  workspace: WorkspaceSummary;
  onClose: () => void;
}

export function OpenWorkspaceDialog({ workspace, onClose }: OpenWorkspaceDialogProps) {
  const { t } = useTranslation();
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const [busy, setBusy] = useState(false);

  const handleOpen = async (closeCurrent: boolean) => {
    setBusy(true);
    try {
      await openWorkspace(workspace.id, closeCurrent);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("workspace.open.title", { name: workspace.name })}
      onClose={onClose}
      size="sm"
      closeOnBackdrop
      closeOnEsc
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => handleOpen(false)}>
            {t("workspace.open.keepCurrent")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => handleOpen(true)}>
            {t("workspace.open.closeCurrent")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t("workspace.open.body")}
      </p>
    </Modal>
  );
}
