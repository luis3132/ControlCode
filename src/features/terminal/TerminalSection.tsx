import { useTranslation } from "react-i18next";
import { Switch } from "neogestify-ui-components";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";

export function TerminalSection() {
  const { t } = useTranslation();
  const inputMarks = useTerminalPrefsStore((s) => s.inputMarks);
  const setInputMarks = useTerminalPrefsStore((s) => s.setInputMarks);
  return (
    <section className="bg-linear-to-br from-white to-gray-50
      dark:from-gray-800 dark:to-gray-900
      rounded-xl border border-gray-200 dark:border-gray-700
      shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

      <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
        {t("settings.terminal")}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t("settings.terminal.desc")}
      </p>

      <Switch
        checked={inputMarks}
        onChange={setInputMarks}
        label={t("settings.terminal.marks")}
        description={t("settings.terminal.marks.desc")}
        labelPosition="left"
      />

      {/* Va fuera del `description` del Switch a propósito: no es lo que hace la opción
          sino dónde NO aplica, y decirlo acá evita el "no anda" cuando en realidad la TUI
          no tiene historial que marcar. */}
      <p className="text-[11px] text-gray-400 dark:text-white/40 mt-3">
        {t("settings.terminal.marks.limits")}
      </p>
      {/* Cambiar esto no reconfigura las terminales ya abiertas: las marcas se enganchan
          al montar. Decirlo evita el "lo apagué y las rayas siguen ahí". */}
      <p className="text-[11px] text-gray-400 dark:text-white/40 mt-2">
        {t("settings.terminal.marks.applies")}
      </p>
    </section>
  );
}
