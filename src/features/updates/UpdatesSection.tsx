import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { AnimateSpin, Button } from "neogestify-ui-components";

import { SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";

import { useUpdatesStore } from "./store";

/** Configuración → Actualizaciones: qué versión hay y buscar una nueva a mano. */
export function UpdatesSection() {
  const { t } = useTranslation();
  const { info, phase, error, check } = useUpdatesStore();
  const [version, setVersion] = useState("");

  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);

  const status = phase === "checking"
    ? t("updates.checking")
    : info === null ? null
      : info.newer ? t("updates.available", { version: info.latest })
        : t("updates.upToDate");

  return (
    <SettingsSection title={t("updates.title")} description={t("updates.description")}>
      <SettingsRow label={t("updates.version", { version })} hint={status ?? undefined}>
        <Button size="sm" variant="outline" disabled={phase === "checking" || phase === "installing"}
          onClick={() => check({ manual: true })} className="flex items-center gap-1.5">
          {phase === "checking" && <AnimateSpin className="w-3.5 h-3.5" />}
          {t("updates.checkNow")}
        </Button>
      </SettingsRow>
      {info && (
        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">
          {info.install === "auto" ? t("updates.modeAuto") : t("updates.modeDownload")}
        </p>
      )}
      {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
    </SettingsSection>
  );
}
