import { useTranslation } from "react-i18next";
import { Switch } from "neogestify-ui-components";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { SettingsSection } from "@/features/settings/SettingsSection";

export function TerminalSection() {
  const { t } = useTranslation();
  const inputMarks = useTerminalPrefsStore((s) => s.inputMarks);
  const setInputMarks = useTerminalPrefsStore((s) => s.setInputMarks);
  const gpuRenderer = useTerminalPrefsStore((s) => s.gpuRenderer);
  const setGpuRenderer = useTerminalPrefsStore((s) => s.setGpuRenderer);
  const compositing = useTerminalPrefsStore((s) => s.compositing);
  return (
    <SettingsSection title={t("settings.terminal")} description={t("settings.terminal.desc")}>

      <Switch
        checked={inputMarks}
        onChange={setInputMarks}
        label={t("settings.terminal.marks")}
        description={t("settings.terminal.marks.desc")}
        labelPosition="left"
      />

      <div className="h-4" />

      <Switch
        checked={gpuRenderer && compositing}
        onChange={setGpuRenderer}
        disabled={!compositing}
        label={t("settings.terminal.gpu")}
        description={t("settings.terminal.gpu.desc")}
        labelPosition="left"
      />
      {/* Sin composición por GPU (la opción de texto nítido de Apariencia) no hay WebGL: el
          switch no puede hacer nada, y decir por qué evita buscar el problema acá. */}
      {!compositing && (
        <p className="text-[11px] text-gray-400 dark:text-white/40 mt-1.5">
          {t("settings.terminal.gpu.noCompositing")}
        </p>
      )}

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
    </SettingsSection>
  );
}
