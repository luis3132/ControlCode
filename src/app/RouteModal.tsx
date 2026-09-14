import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "neogestify-ui-components";

import { hasOpenDialog } from "@/shared/ui/openDialog";
import { useFocusInside } from "@/shared/ui/useFocusInside";

/**
 * El marco que convierte una ruta en un modal.
 *
 * Skills y Marketplace eran páginas: navegar a ellas tapaba las terminales enteras y
 * había que volver para ver qué estaba haciendo un agente. Como modal, los agentes
 * siguen ahí atrás y se cierra con Escape.
 *
 * Lo importante es que las rutas NO cambian: adentro se sigue navegando igual (el detalle
 * de una skill, los repositorios del marketplace), y lo único distinto es dónde se pinta.
 */
export function RouteModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  // Ver `useFocusInside`: sin esto el teclado seguía en la terminal de atrás.
  useFocusInside(frameRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Un diálogo abierto encima es el dueño de este Escape (ver `hasOpenDialog`).
      if (hasOpenDialog()) return;
      // Se corta acá: si no, el Escape sigue viaje hasta la terminal de atrás y el agente
      // lo recibe como si lo hubieras tecleado vos.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-6">
      <button
        onClick={onClose}
        aria-label={t("btn.close")}
        className="cc-fade absolute inset-0 bg-gray-900/45 dark:bg-black/65"
      />

      <div ref={frameRef} tabIndex={-1} className="outline-none cc-rise relative flex flex-col w-full max-w-5xl h-full
        rounded-2xl overflow-hidden
        bg-gray-50 dark:bg-[#0d1117]
        border border-gray-200 dark:border-white/12
        shadow-2xl">

        <button
          onClick={onClose}
          title={t("btn.close")}
          className="absolute top-3 right-3 z-10 flex items-center justify-center w-8 h-8 rounded-lg
            text-gray-400 dark:text-white/35
            bg-white/80 dark:bg-white/8
            hover:text-gray-700 dark:hover:text-white
            hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
        >
          <CloseIcon className="w-4 h-4" />
        </button>

        {/* Sin scroll propio: las rutas que se pintan acá son de alto completo y
            scrollean por dentro. Ver la nota equivalente en `AppShell`. */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
