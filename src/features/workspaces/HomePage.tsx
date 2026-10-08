import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { launchAgent } from "@/features/tabs/tabActions";
import { useAgentWizard } from "@/features/tabs/wizard/useAgentWizard";

/**
 * Inicio: donde arranca un workspace nuevo. Es el asistente de agente nuevo puesto en la
 * página —carpeta, agente, cuenta, skills—, sin modal: acá no hay nada debajo que tapar, y
 * empezar es justamente lo que se vino a hacer.
 *
 * Los pasos son los mismos que los del "+" (`useAgentWizard`); para sumar más carpetas a un
 * workspace que ya arrancó está "Agregar carpeta", que los abre en un modal. Los workspaces
 * guardados no viven acá sino en el selector de la barra de tabs.
 */
export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { body, footer } = useAgentWizard({
    active: true,
    onConfirm: (result) => {
      launchAgent(result);
      navigate("/workspace");
    },
  });

  return (
    <div className="cc-scroll h-full bg-gray-50 dark:bg-[#0d1117]">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 pt-16 pb-10">

        <header className="flex flex-col gap-2">
          <span className="w-fit text-[11px] font-bold uppercase tracking-[0.14em] bg-clip-text text-transparent
            bg-linear-to-r from-blue-600 to-violet-600 dark:from-blue-400 dark:to-violet-400">
            Control Code
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
            {t("home.title")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-white/50">
            {t("home.subtitle")}
          </p>
        </header>

        <div className="flex flex-col rounded-2xl overflow-hidden
          border border-gray-200 dark:border-white/8 bg-white dark:bg-white/[0.02] shadow-sm">
          <div className="p-6">{body}</div>
          <div className="flex px-6 py-4 border-t border-gray-200 dark:border-white/8
            bg-gray-50/60 dark:bg-white/[0.015]">
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}
