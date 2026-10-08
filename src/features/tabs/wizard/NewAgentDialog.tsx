import { useTranslation } from "react-i18next";

import { useAgentWizard, type WizardResult } from "@/features/tabs/wizard/useAgentWizard";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { AppDialog } from "@/shared/ui/AppDialog";

interface NewAgentDialogProps {
  isOpen: boolean;
  /** La carpeta donde va a abrirse. Sin ella, el primer paso es elegirla ("Agregar carpeta"). */
  cwd?: string;
  onClose: () => void;
  onConfirm: (result: WizardResult) => void;
  /** Al duplicar una tab: sus skills vienen marcadas en cualquier TUI que se elija (las
   *  que esa TUI soporta), y sus comandos previos también. */
  initialSkillIds?: string[];
  initialPrelaunch?: PrelaunchStep[];
  title?: string;
}

/**
 * El asistente de agente nuevo, en un modal: el "+" de la barra de tabs (la carpeta ya está
 * decidida, es la del agente que se está mirando) y "Agregar carpeta" (que empieza por
 * elegirla). Los pasos son los de `useAgentWizard`, los mismos que Inicio muestra en la
 * página.
 */
export function NewAgentDialog({
  isOpen, cwd, onClose, onConfirm, initialSkillIds, initialPrelaunch, title,
}: NewAgentDialogProps) {
  const { t } = useTranslation();
  const { body, footer } = useAgentWizard({
    active: isOpen,
    cwd,
    initialSkillIds,
    initialPrelaunch,
    onCancel: onClose,
    onConfirm: (result) => {
      onConfirm(result);
      onClose();
    },
  });

  if (!isOpen) return null;

  return (
    <AppDialog
      onClose={onClose}
      title={title ?? t("newAgent.title")}
      size="lg"
      closeOnBackdrop={false}
      // El footer de la librería es una fila alineada a la derecha: el pie del asistente
      // ocupa todo el ancho (`flex-1`) para que la barra de progreso lo cruce entero.
      footer={footer}
    >
      {body}
    </AppDialog>
  );
}
