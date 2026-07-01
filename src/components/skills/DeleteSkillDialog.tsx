import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";
import { useSkillsStore, SkillSummary } from "../../store/skills";

interface DeleteSkillDialogProps {
  skill: SkillSummary;
  onClose: () => void;
}

export function DeleteSkillDialog({ skill, onClose }: DeleteSkillDialogProps) {
  const { t } = useTranslation();
  const deleteSkill = useSkillsStore((s) => s.deleteSkill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await deleteSkill(skill.id);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("skills.delete.title", { name: skill.name })}
      onClose={onClose}
      size="sm"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      variant="danger"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={handleConfirm}>
            {t("skills.delete.confirm")}
          </Button>
        </>
      }
    >
      {skill.usedBy.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("skills.delete.bodyNone")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("skills.delete.bodyImpact")}</p>
          <ul className="flex flex-col gap-1 text-xs font-mono text-red-500 dark:text-red-400">
            {skill.usedBy.map((u, i) => (
              <li key={i}>
                {u.workspaceName}
                {u.scope === "tab" ? ` › ${u.tabTitle ?? u.tabId}` : ` (${t("skills.attach.scopeWorkspace")})`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </Modal>
  );
}
