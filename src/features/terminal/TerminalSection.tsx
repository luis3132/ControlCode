import { useTranslation } from "react-i18next";
import { Button, Slider, Switch, useTheme } from "neogestify-ui-components";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import {
  TERMINAL_FONT, TERMINAL_THEMES, TERMINAL_ZOOM, terminalFontSize,
} from "@/features/terminal/theme";
import { SettingsSection } from "@/features/settings/SettingsSection";

/**
 * El zoom del texto. Se aplica en vivo a todas las terminales abiertas, pero están detrás
 * de Configuración: la muestra de abajo, con la misma fuente, tamaño y colores, es lo que
 * deja elegir sin cerrar para ver cómo quedó.
 */
function ZoomSetting() {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const zoom = useTerminalPrefsStore((s) => s.zoom);
  const setZoom = useTerminalPrefsStore((s) => s.setZoom);
  const palette = TERMINAL_THEMES[theme === "dark" ? "dark" : "light"];

  return (
    <div className="flex flex-col gap-2">
      <Slider
        label={t("settings.terminal.zoom")}
        helperText={t("settings.terminal.zoom.desc")}
        min={TERMINAL_ZOOM.min}
        max={TERMINAL_ZOOM.max}
        step={TERMINAL_ZOOM.step}
        value={zoom}
        onChange={setZoom}
        showValue
        formatValue={(value) => `${value} % · ${terminalFontSize(value)} px`}
        size="sm"
      />
      <div
        className="rounded-lg px-3 py-2 overflow-hidden whitespace-nowrap text-ellipsis
          border border-gray-200 dark:border-white/10"
        style={{
          background: palette.background,
          color: palette.foreground,
          fontFamily: TERMINAL_FONT,
          fontSize: terminalFontSize(zoom),
          lineHeight: 1.1,
        }}
      >
        <span style={{ color: palette.brightBlue }}>❯ </span>
        {t("settings.terminal.zoom.sample")}
      </div>
      {zoom !== TERMINAL_ZOOM.default && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setZoom(TERMINAL_ZOOM.default)}>
            {t("settings.terminal.zoom.reset")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TerminalSection() {
  const { t } = useTranslation();
  const inputMarks = useTerminalPrefsStore((s) => s.inputMarks);
  const setInputMarks = useTerminalPrefsStore((s) => s.setInputMarks);
  const gpuRenderer = useTerminalPrefsStore((s) => s.gpuRenderer);
  const setGpuRenderer = useTerminalPrefsStore((s) => s.setGpuRenderer);
  const compositing = useTerminalPrefsStore((s) => s.compositing);
  return (
    <SettingsSection title={t("settings.terminal")} description={t("settings.terminal.desc")}>

      <ZoomSetting />

      <div className="h-4" />

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
