import { useTranslation } from "react-i18next";

import { SHORTCUTS } from "@/app/shortcuts";
import { SettingsSection } from "@/features/settings/SettingsSection";

/** Cada tecla en su propia caja, como se dibuja una tecla. */
function Chord({ display }: { display: string }) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      {display.split("+").map((key) => (
        <kbd
          key={key}
          className="px-1.5 py-0.5 rounded border text-[11px] font-mono leading-none
            border-gray-300 dark:border-gray-600
            bg-gray-100 dark:bg-white/10
            text-gray-700 dark:text-gray-200"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Referencia de atajos.
 *
 * Es de solo lectura y aun así vale la pena: un atajo que nadie sabe que existe no
 * existe, y el tooltip de la barra superior solo cubre los que tienen botón — Ctrl+Tab
 * no aparecería en ningún lado.
 */
export function ShortcutsSection() {
  const { t } = useTranslation();

  return (
    <SettingsSection title={t("settings.shortcuts")} description={t("settings.shortcuts.desc")}>

      <ul className="flex flex-col divide-y divide-gray-200 dark:divide-gray-700">
        {SHORTCUTS.map((s) => (
          <li key={s.display} className="flex items-center justify-between gap-4 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300 min-w-0 truncate">
              {t(s.labelKey)}
            </span>
            <Chord display={s.display} />
          </li>
        ))}
      </ul>

      {/* Lo que un atajo global le saca a la terminal se dice acá y no se descubre a los
          tres días: son teclas que las TUIs ya usaban. */}
      <p className="mt-5 px-3 py-2 rounded-lg text-xs
        bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300">
        {t("settings.shortcuts.terminalNote")}
      </p>
    </SettingsSection>
  );
}
