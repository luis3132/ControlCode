import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "neogestify-ui-components";

/**
 * El marco de un modal de la app (Configuración, Cuentas).
 *
 * Se abren desde el riel, encima de las terminales y sin cambiar de ruta: los agentes
 * siguen corriendo detrás y se vuelve con Escape. Eso vale para cualquiera de estas
 * pantallas, así que el marco vive acá en vez de estar copiado en cada una.
 *
 * No lo usan las rutas-modal (Skills, Marketplace): ésas necesitan que la URL cambie para
 * poder navegar adentro, y ese marco es `RouteModal`.
 */
export function ShellModal({ title, icon, width = "max-w-4xl", onClose, children }: {
  title: string;
  icon?: React.ReactNode;
  /** Clase de ancho máximo. Configuración necesita más que Cuentas. */
  width?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
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
        className="cc-fade absolute inset-0 bg-gray-900/45 dark:bg-black/65"
      />

      <div className={`cc-rise relative flex flex-col w-full ${width} h-full max-h-[42rem]
        rounded-2xl overflow-hidden
        bg-gray-50 dark:bg-[#0d1117]
        border border-gray-200 dark:border-white/12
        shadow-2xl`}>

        <div className="flex items-center gap-3 h-[54px] shrink-0 pl-4 pr-3 shadow-none
          border-b border-gray-200 dark:border-white/8">
          {icon}
          <h2 className="flex-1 min-w-0 truncate text-[13.5px] font-bold
            text-gray-900 dark:text-white">
            {title}
          </h2>
          <button
            onClick={onClose}
            title={t("btn.close")}
            aria-label={t("btn.close")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">{children}</div>
      </div>
    </div>
  );
}
