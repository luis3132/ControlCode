import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";

interface ExitConfirmDialogProps {
  title: string;
  body: string;
  onCloseAll: () => void;
  onCloseCurrent: () => void;
  onCancel: () => void;
}

/**
 * Diálogo "¿cerrar todo o solo esta ventana?" — puramente presentacional.
 * `title`/`body` los define quien lo usa: el alcance de "todo" varía según el
 * disparador (todas las ventanas del workspace actual, o toda la app al salir).
 */
export function ExitConfirmDialog({ title, body, onCloseAll, onCloseCurrent, onCancel }: ExitConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={onCloseCurrent}>
            {t("app.exit.closeCurrent")}
          </Button>
          <Button variant="primary" onClick={onCloseAll}>
            {t("app.exit.closeAll")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {body}
      </p>
    </Modal>
  );
}
