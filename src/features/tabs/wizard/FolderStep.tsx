import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, CloudIcon, FolderIcon, Input } from "neogestify-ui-components";

import { CloneRepoDialog } from "@/features/forge/CloneRepoDialog";

/**
 * El primer paso de un agente en una carpeta nueva: dónde. Se elige de la máquina, se clona
 * un repo o se pega la ruta. Elegir o clonar avanza solo (`onPicked`); una ruta escrita se
 * confirma con "Siguiente" o Enter, que puede ir a medio escribir.
 */
export function FolderStep({ value, onChange, onPicked }: {
  value: string;
  onChange: (cwd: string) => void;
  onPicked: (cwd: string) => void;
}) {
  const { t } = useTranslation();
  const [cloning, setCloning] = useState(false);

  const browse = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("home.dialogTitle") });
    if (typeof selected === "string" && selected) onPicked(selected);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile
          icon={<FolderIcon className="w-[18px] h-[18px]" />}
          title={t("home.browse.title")}
          body={t("home.browse.body")}
          onClick={() => { browse().catch(console.error); }}
        />
        {/* Un repo que todavía no está en esta máquina: se clona con la cuenta de git y se
            sigue en la carpeta nueva. */}
        <Tile
          icon={<CloudIcon className="w-[18px] h-[18px]" />}
          title={t("home.clone.title")}
          body={t("home.clone.body")}
          onClick={() => setCloning(true)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="folder-step-path" className="text-xs font-medium text-gray-500 dark:text-white/45">
          {t("home.path.label")}
        </label>
        <Input
          id="folder-step-path"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onPicked(value.trim()); }}
          placeholder={t("home.pathPlaceholder")}
          variant="outline"
          className="font-mono text-[13px]!"
        />
      </div>

      {cloning && (
        <CloneRepoDialog
          onClose={() => setCloning(false)}
          onCloned={(cloned) => {
            setCloning(false);
            onPicked(cloned);
          }}
        />
      )}
    </div>
  );
}

function Tile({ icon, title, body, onClick }: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <Button variant="custom"
      onClick={onClick}
      className="cc-t flex items-start justify-start gap-3 p-4 rounded-xl text-left
        border border-gray-200 dark:border-white/8 bg-white dark:bg-white/[0.02]
        hover:border-blue-400/60 dark:hover:border-blue-400/35
        hover:bg-blue-50/50 dark:hover:bg-blue-400/[0.04]"
    >
      <span className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0
        bg-blue-500/10 text-blue-600 dark:bg-blue-400/12 dark:text-blue-400">
        {icon}
      </span>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
        <span className="text-xs leading-snug text-gray-500 dark:text-white/45">{body}</span>
      </span>
    </Button>
  );
}
