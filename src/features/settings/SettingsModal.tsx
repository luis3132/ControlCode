import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "neogestify-ui-components";

import { SettingsPage } from "@/features/settings/SettingsPage";

/**
 * Configuración como modal.
 *
 * Antes era una ruta, y navegar a ella tapaba las terminales enteras: había que volver
 * para ver qué estaba haciendo un agente. Como modal, los agentes siguen ahí atrás y se
 * vuelve con Escape.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Se corta acá: si no, el Escape sigue viaje hasta la terminal que está detrás y el
      // agente lo recibe como si lo hubieras tecleado vos.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-8">
      <button
        onClick={onClose}
        aria-label={t("btn.close")}
        className="absolute inset-0 bg-gray-900/40 dark:bg-black/62 backdrop-blur-[2px]"
      />

      <div className="relative flex flex-col w-full max-w-4xl h-full max-h-[42rem]
        rounded-2xl overflow-hidden
        bg-white dark:bg-gray-900
        border border-gray-200 dark:border-white/12
        shadow-2xl">

        <div className="flex items-center gap-3 h-12 shrink-0 pl-6 pr-3
          border-b border-gray-200 dark:border-white/8">
          <h2 className="flex-1 text-[15px] font-bold text-gray-900 dark:text-white">
            {t("settings.title")}
          </h2>
          <button
            onClick={onClose}
            title={t("btn.close")}
            className="flex items-center justify-center w-8 h-8 rounded-lg
              text-gray-400 dark:text-gray-500
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 cc-scroll">
          <SettingsPage embedded />
        </div>
      </div>
    </div>
  );
}
