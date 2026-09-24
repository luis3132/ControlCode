import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, TextArea } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { forgeCreateIssue } from "./ipc";
import { forgeErrorOf, type ForgeItem } from "./types";

export function CreateIssueDialog({ cwd, onClose, onCreated }: {
  cwd: string;
  onClose: () => void;
  onCreated: (item: ForgeItem) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated(await forgeCreateIssue(cwd, {
        title: title.trim(),
        body: body.trim() || undefined,
        labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
      }));
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("forge.issue.new")}
      onClose={onClose}
      size="md"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={create}>
            {busy ? t("forge.working") : t("forge.issue.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label={t("forge.title")} value={title} onChange={(e) => setTitle(e.target.value)}
          variant="outline" disabled={busy} autoFocus />
        <TextArea label={t("forge.body")} value={body} onChange={(e) => setBody(e.target.value)}
          variant="outline" rows={6} resize="none" disabled={busy} placeholder={t("forge.bodyPlaceholder")} />
        <Input label={t("forge.issue.labels")} value={labels} onChange={(e) => setLabels(e.target.value)}
          variant="outline" disabled={busy} placeholder="bug, ui" helperText={t("forge.issue.labelsHelper")} />
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
