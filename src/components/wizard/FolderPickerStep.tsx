import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { HomeIcon, FolderIcon } from "neogestify-ui-components";

interface FolderPickerStepProps {
  initialPath: string;
  onPathChange: (path: string) => void;
}

export function FolderPickerStep({ initialPath, onPathChange }: FolderPickerStepProps) {
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
      title: "Seleccionar carpeta de proyecto",
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
      <p className="text-xs text-white/50">¿Dónde está el proyecto?</p>

      <div className="flex flex-col gap-2">
        <Button variant="outline" leftIcon={<HomeIcon />} fullWidth onClick={handleHome}>
          Directorio home
        </Button>
        <Button variant="outline" leftIcon={<FolderIcon />} fullWidth onClick={handleExplorer}>
          Explorador del sistema
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-white/40">O escribe la ruta:</p>
        <Input
          value={manualPath}
          onChange={(e) => handleManualChange(e.target.value)}
          placeholder="/home/usuario/mi-proyecto"
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
