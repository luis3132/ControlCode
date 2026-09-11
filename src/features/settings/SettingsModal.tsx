import { useTranslation } from "react-i18next";
import { GearIcon } from "neogestify-ui-components";

import { SettingsPage } from "@/features/settings/SettingsPage";
import { ShellModal } from "@/shared/ui/ShellModal";

/**
 * Configuración como modal.
 *
 * Antes era una ruta, y navegar a ella tapaba las terminales enteras: había que volver
 * para ver qué estaba haciendo un agente. Como modal, los agentes siguen ahí atrás y se
 * vuelve con Escape.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ShellModal
      title={t("settings.title")}
      icon={<GearIcon className="w-[15px] h-[15px] shrink-0 text-gray-400 dark:text-white/40" />}
      onClose={onClose}
    >
      <SettingsPage />
    </ShellModal>
  );
}
