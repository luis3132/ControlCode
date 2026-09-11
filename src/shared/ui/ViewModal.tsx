import { createPortal } from "react-dom";
import { Modal } from "neogestify-ui-components";

import { DIALOG_BODY_CLASS, DIALOG_PANEL_CLASS, DialogHeader } from "@/shared/ui/AppDialog";

/** Contenedor que AppShell deja en el área de contenido. Ver `App.css`. */
export const VIEW_OVERLAY_ID = "cc-view-overlay";

type ModalProps = Parameters<typeof Modal>[0];

interface ViewModalProps extends ModalProps {
  /**
   * Ocupar la vista entera en vez de centrarse con su ancho natural.
   *
   * Es explícito y no automático porque depende del contenido: un editor quiere todo el
   * espacio, una confirmación de dos líneas estirada a pantalla completa se ve absurda.
   */
  fill?: boolean;
}

/**
 * Un modal que vive dentro de la VISTA, no encima de toda la ventana.
 *
 * El `Modal` de la librería es `fixed inset-0`: se mide contra el viewport, así que tapaba
 * la barra de título y la de tabs — que son justamente lo que el usuario necesita para
 * salir de donde está. Acá se monta dentro de `#cc-view-overlay`, un contenedor que
 * AppShell deja cubriendo el área de contenido y que tiene `transform`; eso hace que el
 * `position: fixed` de sus descendientes se resuelva contra ÉL. El modal queda encerrado
 * en la vista y la ocupa entera (las reglas que lo estiran están en `App.css`, porque sus
 * `max-w`/`max-h` vienen en unidades de viewport y ahí ya no significan lo mismo).
 *
 * Los diálogos de la app —salir, cerrar todas las ventanas— siguen usando `Modal` directo:
 * esos SÍ son de la ventana entera y tapar la barra es lo correcto.
 */
export function ViewModal({ fill, title, ...props }: ViewModalProps) {
  const host = document.getElementById(VIEW_OVERLAY_ID);
  // Misma piel que `AppDialog`: se aplica acá y no allá porque este monta el `Modal` por
  // su cuenta para poder portalearlo, pero tiene que verse igual que cualquier diálogo.
  const modal = (
    <div className={fill ? "cc-modal-fill" : undefined}>
      <Modal
        {...props}
        aria-label={typeof title === "string" ? title : undefined}
        className={DIALOG_PANEL_CLASS}
        bodyClassName={DIALOG_BODY_CLASS}
        header={
          <DialogHeader
            title={typeof title === "string" ? title : ""}
            onClose={props.onClose}
          />
        }
      />
    </div>
  );

  // Sin host (una vista montada fuera del shell, o un test) se comporta como el modal de
  // siempre: es preferible un modal a pantalla completa que ningún modal.
  return host ? createPortal(modal, host) : modal;
}
