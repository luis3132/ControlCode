import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

interface SkillFilePickerStepProps {
  initialPath: string;
  onPathChange: (path: string) => void;
}

/** Selector del archivo SKILL.md puntual a instalar (no de la carpeta contenedora) —
 *  la carpeta que se copia al instalar se deriva del archivo elegido en el backend. */
export function SkillFilePickerStep({ initialPath, onPathChange }: SkillFilePickerStepProps) {
  const { t } = useTranslation();
  const [manualPath, setManualPath] = useState("");

  const handleBrowse = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t("skills.install.dialogTitle"),
      filters: [{ name: "SKILL.md", extensions: ["md"] }],
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

      <Button variant="outline" leftIcon={<FolderIcon />} fullWidth onClick={handleBrowse}>
        {t("skills.install.browseBtn")}
      </Button>

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
