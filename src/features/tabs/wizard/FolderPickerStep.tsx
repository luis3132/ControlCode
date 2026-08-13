import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { HomeIcon, FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

interface FolderPickerStepProps {
  initialPath: string;
  onPathChange: (path: string) => void;
}

export function FolderPickerStep({ initialPath, onPathChange }: FolderPickerStepProps) {
  const { t } = useTranslation();
  const [manualPath, setManualPath] = useState("");

  const handleHome = async () => {
    const home = await invoke<string>("get_home_dir");
    onPathChange(home);
    setManualPath("");
  };

  const handleExplorer = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("wizard.step1.dialogTitle"),
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
      <p className="text-xs text-white/50">{t("wizard.step1.helper")}</p>

      <div className="flex flex-col gap-2">
        <Button variant="outline" leftIcon={<HomeIcon />} fullWidth onClick={handleHome}>
          {t("wizard.step1.homeBtn")}
        </Button>
        <Button variant="outline" leftIcon={<FolderIcon />} fullWidth onClick={handleExplorer}>
          {t("wizard.step1.browseBtn")}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-white/40">{t("wizard.step1.orType")}</p>
        <Input
          value={manualPath}
          onChange={(e) => handleManualChange(e.target.value)}
          placeholder={t("wizard.step1.pathPlaceholder")}
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
