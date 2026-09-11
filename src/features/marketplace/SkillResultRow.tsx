import { useTranslation } from "react-i18next";
import { AnimateSpin, Badge, CheckIcon, CloudIcon, FolderIcon } from "neogestify-ui-components";

import type { MarketplaceSkillEntry, RegistrySourceType } from "./types";

/** Una fila de resultado de la búsqueda, al estilo de una paleta de comandos. */
export function SkillResultRow({
  skill, sourceType, selected, installed, installing, onSelect, onInstall,
}: {
  skill: MarketplaceSkillEntry;
  sourceType: RegistrySourceType | undefined;
  selected: boolean;
  installed: boolean;
  installing: boolean;
  onSelect: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const Icon = sourceType === "local" ? FolderIcon : CloudIcon;

  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => { if (!installed && !installing) onInstall(); }}
      className={`cc-t flex items-center gap-3 h-[42px] mx-1.5 px-2.5 rounded-lg cursor-pointer
        ${selected
          ? "bg-blue-500/12 dark:bg-blue-400/13 shadow-[inset_0_0_0_1px_rgba(88,166,255,0.24)]"
          : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
    >
      <span
        className={`flex items-center justify-center w-6 h-6 rounded-md shrink-0
          ${installed
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : "bg-violet-500/12 text-violet-500 dark:text-violet-400"}`}
      >
        {installed ? <CheckIcon className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
      </span>

      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className={`text-[12.5px] font-semibold truncate
          ${selected ? "text-gray-900 dark:text-white" : "text-gray-800 dark:text-gray-200"}`}>
          {skill.name}
        </span>
        <span className="text-[10.5px] font-mono truncate text-gray-400 dark:text-white/35">
          {[skill.author, skill.registryName, skill.installs && t("marketplace.installs", { n: skill.installs })]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>

      {installing ? (
        <AnimateSpin className="w-3.5 h-3.5 shrink-0 text-gray-400" />
      ) : installed ? (
        <Badge variant="success" size="sm" className="shrink-0">{t("marketplace.installed")}</Badge>
      ) : selected ? (
        <span className="shrink-0 flex items-center h-5 px-1.5 rounded border text-[10px] font-mono
          border-gray-300 dark:border-white/15 text-gray-500 dark:text-gray-400">
          ↵
        </span>
      ) : null}
    </div>
  );
}
