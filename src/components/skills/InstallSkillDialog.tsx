import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal, TextArea } from "neogestify-ui-components";
import { useSkillsStore, SkillFrontmatterInput } from "../../store/skills";
import { SkillFilePickerStep } from "./SkillFilePickerStep";

interface InstallSkillDialogProps {
  onClose: () => void;
}

type Step = "file" | "metadata";

const parseList = (v: string): string[] =>
  v.split(",").map((s) => s.trim()).filter(Boolean);

export function InstallSkillDialog({ onClose }: InstallSkillDialogProps) {
  const { t } = useTranslation();
  const { previewSkill, installSkill } = useSkillsStore();
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [meta, setMeta] = useState<SkillFrontmatterInput | null>(null);
  const [categoriesText, setCategoriesText] = useState("");
  const [agentsText, setAgentsText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isMissing = (field: string) => missing.includes(field);

  // Paso 1 → 2: lee el frontmatter del SKILL.md elegido. Si falta metadata "sugerida"
  // (version, categorías, agentes compatibles, autor, licencia, homepage) se ofrece un
  // formulario para completarla — completamente OPCIONAL, nunca bloquea la instalación.
  const handleNext = async () => {
    if (!file.trim()) {
      setError(t("skills.install.noFile"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const preview = await previewSkill(file.trim());
      if (preview.missing.length === 0) {
        await installSkill(file.trim());
        onClose();
        return;
      }
      setMeta(preview.meta);
      setCategoriesText(preview.meta.categories.join(", "));
      setAgentsText(preview.meta.compatibleAgents.join(", "));
      setMissing(preview.missing);
      setStep("metadata");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doInstall = async (withMeta: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (withMeta && meta) {
        await installSkill(file.trim(), {
          ...meta,
          categories: parseList(categoriesText),
          compatibleAgents: parseList(agentsText),
        });
      } else {
        await installSkill(file.trim());
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === "metadata" && meta) {
    return (
      <Modal
        title={t("skills.install.metadataTitle")}
        onClose={onClose}
        size="md"
        closeOnBackdrop={!busy}
        closeOnEsc={!busy}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => doInstall(false)}>
              {t("skills.install.skip")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => doInstall(true)}>
              {t("skills.install.saveAndInstall")}
            </Button>
          </>
        }
      >
        <p className="text-xs text-gray-500 dark:text-white/50 mb-4">
          {t("skills.install.metadataHelper")}
        </p>
        <div className="flex flex-col gap-3">
          {isMissing("description") && (
            <TextArea
              label={t("skills.install.field.description")}
              value={meta.description ?? ""}
              onChange={(e) => setMeta({ ...meta, description: e.target.value })}
              variant="outline"
              size="small"
            />
          )}
          {isMissing("version") && (
            <Input
              label={t("skills.install.field.version")}
              value={meta.version ?? ""}
              onChange={(e) => setMeta({ ...meta, version: e.target.value })}
              placeholder="1.0.0"
              variant="outline"
            />
          )}
          {isMissing("categories") && (
            <Input
              label={t("skills.install.field.categories")}
              value={categoriesText}
              onChange={(e) => setCategoriesText(e.target.value)}
              placeholder="git, productivity"
              variant="outline"
            />
          )}
          {isMissing("compatibleAgents") && (
            <Input
              label={t("skills.install.field.compatibleAgents")}
              value={agentsText}
              onChange={(e) => setAgentsText(e.target.value)}
              placeholder="claude-code, gemini-cli"
              variant="outline"
            />
          )}
          {isMissing("author") && (
            <Input
              label={t("skills.install.field.author")}
              value={meta.author ?? ""}
              onChange={(e) => setMeta({ ...meta, author: e.target.value })}
              variant="outline"
            />
          )}
          {isMissing("license") && (
            <Input
              label={t("skills.install.field.license")}
              value={meta.license ?? ""}
              onChange={(e) => setMeta({ ...meta, license: e.target.value })}
              placeholder="MIT"
              variant="outline"
            />
          )}
          {isMissing("homepage") && (
            <Input
              label={t("skills.install.field.homepage")}
              value={meta.homepage ?? ""}
              onChange={(e) => setMeta({ ...meta, homepage: e.target.value })}
              placeholder="https://…"
              variant="outline"
            />
          )}
        </div>
        {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title={t("skills.install.title")}
      onClose={onClose}
      size="md"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={handleNext}>
            {t("skills.install.btn")}
          </Button>
        </>
      }
    >
      <p className="text-xs text-gray-500 dark:text-white/50 mb-3">
        {t("skills.install.helper")}
      </p>
      <SkillFilePickerStep initialPath={file} onPathChange={(p) => { setFile(p); setError(""); }} />
      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </Modal>
  );
}
