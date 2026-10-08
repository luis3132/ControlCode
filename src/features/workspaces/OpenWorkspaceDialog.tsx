import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
} from "neogestify-ui-components";
import { useWorkspacesStore } from "@/features/workspaces/store";
import type { WorkspaceSummary } from "@/features/workspaces/types";
import { AppDialog } from "@/shared/ui/AppDialog";

interface OpenWorkspaceDialogProps {
  workspace: WorkspaceSummary;
  onClose: () => void;
}

export function OpenWorkspaceDialog({ workspace, onClose }: OpenWorkspaceDialogProps) {
  const { t } = useTranslation();
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const [busy, setBusy] = useState(false);

  const handleOpen = async (where: "here" | "new") => {
    setBusy(true);
    try {
      await openWorkspace(workspace.id, where);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("workspace.open.title", { name: workspace.name })}
      onClose={onClose}
      size="sm"
      closeOnBackdrop
      closeOnEsc
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => handleOpen("new")}>
            {t("workspace.open.newWindow")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => handleOpen("here")}>
            {t("workspace.open.here")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t("workspace.open.body")}
      </p>
    </AppDialog>
  );
}
