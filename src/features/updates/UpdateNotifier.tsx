import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, CloseIcon, Progress } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";
import { Markdown } from "@/shared/ui/Markdown";

import { useUpdatesStore } from "./store";

/** Primera búsqueda un rato después de abrir: que la app termine de levantar primero. */
const FIRST_CHECK_MS = 20_000;
/** Después, cada tanto: una app que queda abierta días también se entera. */
const EVERY_MS = 6 * 60 * 60_000;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * El aviso de versión nueva, en una esquina: no interrumpe lo que se está haciendo.
 *
 * Donde hay actualización automática, "Actualizar" baja la versión nueva, verifica su
 * firma y la instala (en .deb/.rpm el sistema pide la contraseña), y "Reiniciar" guarda
 * todo como al cerrar. Donde no, ofrece el instalador exacto de este sistema.
 */
export function UpdateNotifier() {
  const { t } = useTranslation();
  const { info, phase, progress, error, open, check, install, restart, skip, dismiss } = useUpdatesStore();
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    const first = setTimeout(() => check().catch(() => {}), FIRST_CHECK_MS);
    const every = setInterval(() => check().catch(() => {}), EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [check]);

  if (!open || !info?.newer) return null;

  const pct = progress?.total ? Math.round((progress.downloaded / progress.total) * 100) : 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl shadow-2xl
      border border-gray-200 dark:border-white/10 bg-white dark:bg-[#11161d]">
      <div className="flex items-start gap-2 px-4 pt-3">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] font-semibold text-gray-900 dark:text-white">
            {t("updates.available", { version: info.latest })}
          </span>
          <span className="text-[11px] text-gray-500 dark:text-white/45">
            {t("updates.current", { version: info.current })}
          </span>
        </div>
        {phase !== "installing" && (
          <button onClick={dismiss} aria-label={t("btn.close")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {info.notes && (
        <div className="px-4 pt-2">
          <button onClick={() => setNotesOpen((v) => !v)} className="text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline">
            {notesOpen ? t("updates.hideNotes") : t("updates.showNotes")}
          </button>
          {notesOpen && (
            <div className="mt-2 max-h-64 cc-scroll rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2 text-[12px]">
              <Markdown content={info.notes} />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 px-4 py-3">
        {phase === "installing" && (
          <Progress
            value={pct}
            indeterminate={!progress?.total}
            showValue={!!progress?.total}
            label={progress?.total
              ? t("updates.downloading", { done: mb(progress.downloaded), total: mb(progress.total) })
              : t("updates.preparing")}
          />
        )}
        {phase === "installed" && (
          <p className="text-[11.5px] text-emerald-600 dark:text-emerald-400">{t("updates.installed")}</p>
        )}
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {phase !== "installing" && phase !== "installed" && (
            <button onClick={skip} className="mr-auto text-[11.5px] text-gray-500 dark:text-white/45 hover:underline">
              {t("updates.skip")}
            </button>
          )}
          <Button size="sm" variant="outline" onClick={() => openUrl(info.pageUrl).catch(console.error)}
            className="flex items-center gap-1">
            <ExternalIcon className="w-3 h-3" />
            GitHub
          </Button>
          {info.install === "auto" ? (
            phase === "installed" ? (
              <Button size="sm" variant="primary" onClick={() => restart().catch(console.error)}>{t("updates.restart")}</Button>
            ) : (
              <Button size="sm" variant="primary" disabled={phase === "installing"} onClick={() => install()}>
                {phase === "installing" ? t("updates.installing") : t("updates.install")}
              </Button>
            )
          ) : info.downloadUrl ? (
            <Button size="sm" variant="primary" onClick={() => openUrl(info.downloadUrl!).catch(console.error)}>
              {t("updates.download", { file: info.assetName ?? "" })}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
