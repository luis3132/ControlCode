import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckIcon, CloudIcon } from "neogestify-ui-components";

import type { MarketplaceSkillEntry } from "./types";

/** Una skill del catálogo remoto, tal como se ve en la grilla. */
export function MarketplaceSkillCard({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: MarketplaceSkillEntry;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3 rounded-xl border
        border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50
        hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm
        transition-all"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0
            bg-violet-50 dark:bg-violet-500/10 text-violet-500 dark:text-violet-400"
        >
          <CloudIcon className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate block">
            {skill.name}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {/* `max-w-full` + `truncate`: el nombre de un repo puede ser largo (una URL de
                GitHub completa) y sin esto estira el badge más allá de la tarjeta. */}
            {/* El autor va PRIMERO y destacado: con dos skills del mismo nombre en la
                grilla, es el único dato que dice cuál es cuál. */}
            {skill.author && (
              <span
                className="max-w-full truncate text-[10px] font-medium px-1.5 py-0.5 rounded-full
                  bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                title={t("marketplace.author", { author: skill.author })}
              >
                {skill.author}
              </span>
            )}
            <span
              className="max-w-full truncate text-[10px] font-mono px-1.5 py-0.5 rounded-full
                bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400"
            >
              {skill.registryName}
            </span>
            {/* Las skills de skills.sh no traen descripción, así que las instalaciones son
                la única señal para comparar entre resultados parecidos. */}
            {skill.installs && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full
                  bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                {t("marketplace.installs", { count: skill.installs })}
              </span>
            )}
            {/* El botón ya lo dice, pero deshabilitado se lee poco: en una grilla conviene
                algo que se note al barrer con la vista. */}
            {installed && (
              <span
                className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full
                  bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <CheckIcon className="w-2.5 h-2.5" />
                {t("marketplace.installed")}
              </span>
            )}
          </span>
        </div>
      </div>

      {skill.description && (
        <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">
          {skill.description}
        </p>
      )}
      {skill.categories.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {skill.categories.map((c) => (
            <span
              key={c}
              className="text-[10px] px-1.5 py-0.5 rounded-full
                bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
            >
              {c}
            </span>
          ))}
        </span>
      )}

      <Button
        variant={installed ? "outline" : "primary"}
        disabled={installed || installing}
        onClick={onInstall}
        className="!text-xs flex items-center justify-center gap-1.5 mt-auto"
      >
        {installing && <AnimateSpin className="w-3 h-3" />}
        {installed
          ? t("marketplace.installed")
          : installing
            ? t("marketplace.installing")
            : t("marketplace.install")}
      </Button>
    </div>
  );
}
