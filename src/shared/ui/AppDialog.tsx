import { useTranslation } from "react-i18next";
import { CloseIcon, Modal } from "neogestify-ui-components";

type DialogSize = "sm" | "md" | "lg" | "xl";

/** El panel. Solo el radio: los colores salen de las variables `--nui-*` de `App.css`. */
export const DIALOG_PANEL_CLASS = "rounded-2xl";

/** El cuerpo, con el respiro de esta UI en vez del `p-6` de la librería. */
export const DIALOG_BODY_CLASS = "px-4 py-3.5 cc-scroll";

/**
 * La cabecera de un diálogo: el mismo lenguaje que las franjas de los paneles del shell,
 * más baja que la de la librería porque un diálogo no necesita tanto aire arriba.
 *
 * Se exporta suelta para que la use también `ViewModal`, que monta el `Modal` de la
 * librería por su cuenta para poder portalearlo dentro de la vista.
 */
export function DialogHeader({ title, icon, onClose }: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 h-11 shrink-0 pl-4 pr-2.5
      border-b border-gray-200 dark:border-white/8">
      {icon}
      <h2 className="flex-1 min-w-0 truncate text-[13px] font-bold
        text-gray-900 dark:text-white">
        {title}
      </h2>
      {/* Cerrar está siempre, incluso cuando el diálogo no se cierra con Escape ni
          clickeando afuera: sin salida visible, un login a medias parece un cuelgue. */}
      <button
        onClick={onClose}
        title={t("btn.close")}
        aria-label={t("btn.close")}
        className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0
          text-gray-400 dark:text-white/35
          hover:text-gray-700 dark:hover:text-white
          hover:bg-gray-200 dark:hover:bg-white/10"
      >
        <CloseIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * Un diálogo de la app.
 *
 * Monta sobre el `Modal` de la librería en vez de reimplementarlo: de ahí salen el portal,
 * la capa, el velo, el bloqueo del scroll, la trampa de foco y el Escape. Lo que cambia es
 * la piel.
 *
 * Los COLORES no se tocan acá. Salen de las variables `--nui-*` que declara `App.css`, que
 * es lo que hace que el resto de los componentes de la librería (botones, inputs, badges)
 * combinen sin que cada diálogo tenga que pisar clases.
 *
 * `closeOnBackdrop` y `closeOnEsc` arrancan apagados, igual que en la librería: hay
 * diálogos —un login a medias, una instalación en curso— en los que cerrar sin querer deja
 * las cosas por la mitad, así que cada uno lo pide explícitamente.
 */
export function AppDialog({
  title,
  icon,
  size = "md",
  footer,
  onClose,
  closeOnBackdrop = false,
  closeOnEsc = false,
  variant,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  size?: DialogSize;
  footer?: React.ReactNode;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  variant?: "default" | "danger" | "success" | "warning";
  children: React.ReactNode;
}) {
  return (
    <Modal
      onClose={onClose}
      size={size}
      variant={variant}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc={closeOnEsc}
      // La cabecera se sustituye entera, así que hace falta `aria-label`: ya no hay un
      // título de la librería al que apuntar.
      aria-label={title}
      className={DIALOG_PANEL_CLASS}
      bodyClassName={DIALOG_BODY_CLASS}
      header={<DialogHeader title={title} icon={icon} onClose={onClose} />}
      footer={footer}
    >
      {children}
    </Modal>
  );
}
