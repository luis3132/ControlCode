import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, Select } from "neogestify-ui-components";
import { useSkillsStore, SkillSummary } from "../../store/skills";
import { useTabsStore } from "../../store/tabs";

interface AttachSkillDialogProps {
  skill: SkillSummary;
  onClose: () => void;
}

/** Attachea una skill al workspace de ESTA ventana (única opción soportada por ahora:
 *  no hay forma de listar las tabs de un workspace cerrado todavía). */
export function AttachSkillDialog({ skill, onClose }: AttachSkillDialogProps) {
  const { t } = useTranslation();
  const attachSkill = useSkillsStore((s) => s.attachSkill);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const tabs = useTabsStore((s) => s.tabs);
  const [scope, setScope] = useState<"workspace" | "tab">("workspace");
  const [tabId, setTabId] = useState(tabs[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    if (scope === "tab" && !tabId) {
      setError(t("skills.attach.noTab"));
      return;
    }
    setBusy(true);
    try {
      await attachSkill(skill.id, workspaceId, scope, scope === "tab" ? tabId : undefined);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("skills.attach.title", { name: skill.name })}
      onClose={onClose}
      size="sm"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={handleConfirm}>
            {t("skills.attach.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t("skills.attach.scope")}
          value={scope}
          onChange={(e) => setScope(e.target.value as "workspace" | "tab")}
          options={[
            { value: "workspace", label: t("skills.attach.scopeWorkspace") },
            { value: "tab", label: t("skills.attach.scopeTab") },
          ]}
          variant="outline"
        />
        {scope === "tab" && (
          <Select
            label={t("skills.attach.tab")}
            value={tabId}
            onChange={(e) => setTabId(e.target.value)}
            options={tabs.map((tab) => ({ value: tab.id, label: tab.title }))}
            placeholder={t("skills.attach.tab")}
            variant="outline"
          />
        )}
        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
