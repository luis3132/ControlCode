import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";

interface ExitConfirmDialogProps {
  windowCount: number;
  onCloseAll: () => void;
  onCloseCurrent: () => void;
  onCancel: () => void;
}

/** Diálogo "¿cerrar todo o solo esta ventana?" — puramente presentacional. */
export function ExitConfirmDialog({ windowCount, onCloseAll, onCloseCurrent, onCancel }: ExitConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      title={t("app.exit.title")}
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
        {t("app.exit.body", { count: windowCount })}
      </p>
    </Modal>
  );
}
