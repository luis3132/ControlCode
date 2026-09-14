import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "neogestify-ui-components";

import { GPU_COMPOSITING_KEY, renderingInfo, setSetting, type RenderingInfo } from "@/shared/ipc/settings";

/**
 * Componer la ventana por GPU, o dibujar con el texto nítido. Solo existe en Linux.
 *
 * El detalle está en `app/rendering.rs`. Lo que importa acá: la opción se lee al arrancar
 * la app, así que cambiarla no hace nada hasta reiniciar — y eso se dice, o el switch
 * parecería no andar.
 */
export function RenderingSetting() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RenderingInfo | null>(null);

  useEffect(() => {
    renderingInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  if (!info?.applies) return null;

  const pendingRestart = !info.forcedByEnv && info.gpuCompositing !== info.activeNow;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <Switch
        checked={info.gpuCompositing}
        disabled={info.forcedByEnv}
        onChange={(value) => {
          setInfo({ ...info, gpuCompositing: value });
          setSetting(GPU_COMPOSITING_KEY, value ? "1" : "0").catch(console.error);
        }}
        label={t("settings.rendering.gpu")}
        description={t("settings.rendering.gpu.desc")}
        labelPosition="left"
        size="sm"
      />
      {info.forcedByEnv && (
        <p className="text-[11px] text-gray-400 dark:text-white/40">{t("settings.rendering.env")}</p>
      )}
      {pendingRestart && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("settings.rendering.restart")}</p>
      )}
    </div>
  );
}
