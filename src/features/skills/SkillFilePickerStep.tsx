import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { DocumentIcon, FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

interface SkillFilePickerStepProps {
  initialPath: string;
  onPathChange: (path: string) => void;
}

/**
 * Qué instalar. Dos formas, y el backend resuelve las dos (`skills::files`):
 *
 * - **Un archivo `.md`**: un `SKILL.md` instala su carpeta, como siempre; cualquier otro
 *   (`facturas-crear.md`) es la skill entera, y se le arma su carpeta con ese nombre.
 * - **Una carpeta**: es la skill, con su nombre, aunque su markdown no se llame SKILL.md.
 */
export function SkillFilePickerStep({ initialPath, onPathChange }: SkillFilePickerStepProps) {
  const { t } = useTranslation();
  const [manualPath, setManualPath] = useState("");

  const handleBrowse = async (directory: boolean) => {
    const selected = await open({
      directory,
      multiple: false,
      title: t(directory ? "skills.install.dialogTitleFolder" : "skills.install.dialogTitle"),
      ...(directory ? {} : { filters: [{ name: "Markdown", extensions: ["md"] }] }),
    });
    if (typeof selected === "string" && selected) {
      onPathChange(selected);
      setManualPath("");
    }
  };

  const handleManualChange = (value: string) => {
    setManualPath(value);
    if (value.trim()) onPathChange(value.trim());
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-white/50">{t("skills.install.filePickerHelper")}</p>

      <div className="flex gap-2">
        <Button variant="outline" leftIcon={<DocumentIcon />} fullWidth onClick={() => handleBrowse(false)}>
          {t("skills.install.browseBtn")}
        </Button>
        <Button variant="outline" leftIcon={<FolderIcon />} fullWidth onClick={() => handleBrowse(true)}>
          {t("skills.install.browseFolderBtn")}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-white/40">{t("wizard.step1.orType")}</p>
        <Input
          value={manualPath}
          onChange={(e) => handleManualChange(e.target.value)}
          placeholder={t("skills.install.filePathPlaceholder")}
          variant="outline"
        />
      </div>

      {initialPath && (
        <p className="text-xs font-mono text-blue-400 truncate">
          ✓ {initialPath}
        </p>
      )}
    </div>
  );
}
