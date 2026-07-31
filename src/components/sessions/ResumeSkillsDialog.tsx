import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, InfoIcon } from "neogestify-ui-components";
import { SessionHistoryEntry, SessionSkillStatus } from "../../store/sessions";
import { SkillPickerStep } from "../wizard/SkillPickerStep";

interface ResumeSkillsDialogProps {
  entry: SessionHistoryEntry;
  /** Estado actual de las skills que la sesión tenía archivadas. */
  statuses: SessionSkillStatus[];
  onCancel: () => void;
  /** Reabre la sesión con exactamente estas skills (ids ya instalados). */
  onConfirm: (skillIds: string[]) => void;
}

/**
 * Elegir con qué skills reabrir una sesión, antes de montar la TUI.
 *
 * Reabrir tal cual (el botón normal de reanudar) restaura lo que la sesión tenía. Pero esa
 * config es la de cuando se cerró, y muchas veces uno vuelve a una sesión justamente para
 * atacarla distinto: sumarle una skill que instaló después, o sacarle una que le está
 * metiendo ruido al contexto. Después de lanzado el agente ya no sirve — varios escanean
 * su carpeta de skills solo al boot — así que la decisión tiene que tomarse acá.
 *
 * Arranca con lo que la sesión tenía (menos lo que ya no está instalado) para que el caso
 * "quiero un ajuste chico" no obligue a re-tildar todo desde cero.
 */
export function ResumeSkillsDialog({
  entry,
  statuses,
  onCancel,
  onConfirm,
}: ResumeSkillsDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);

  // Preselección: las archivadas que siguen instaladas. `installedSkillId` ya resuelve el
  // caso de una skill reinstalada con otro id pero el mismo nombre.
  useEffect(() => {
    setSelected(
      statuses
        .map((s) => s.installedSkillId)
        .filter((id): id is string => id !== null)
    );
  }, [statuses]);

  const missing = statuses.filter((s) => !s.installedSkillId);

  const original = useMemo(
    () => new Set(statuses.map((s) => s.installedSkillId).filter(Boolean)),
    [statuses]
  );
  const added = selected.filter((id) => !original.has(id)).length;
  const removed = [...original].filter((id) => id && !selected.includes(id)).length;
  const changed = added > 0 || removed > 0;

  return (
    <Modal
      title={t("sessions.resumeSkills.title")}
      onClose={onCancel}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("btn.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onConfirm(selected)}>
            {t("sessions.resumeSkills.open")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("sessions.resumeSkills.body", {
              session: entry.title ?? entry.agentLabel,
            })}
          </p>
        </div>

        {/* `SkillPickerStep` carga las skills y resuelve por su cuenta los casos "no hay
            ninguna instalada" y "ninguna compatible con este agente". */}
        <SkillPickerStep
          agentId={entry.agentId}
          selected={selected}
          onChange={setSelected}
        />

        {/* Lo que la sesión tenía y ya no está instalado no se puede tildar, pero callarlo
            sería peor: el usuario tiene que saber con qué NO va a contar. */}
        {missing.length > 0 && (
          <div className="flex flex-col gap-1 px-3 py-2 rounded-lg
            border border-amber-200 dark:border-amber-500/30
            bg-amber-50 dark:bg-amber-500/10">
            <span className="text-[11px] font-semibold uppercase tracking-wide
              text-amber-600 dark:text-amber-400">
              {t("sessions.resumeSkills.missingTitle")}
            </span>
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {missing.map((s) => s.name).join(", ")}
            </span>
            <span className="text-[11px] text-amber-600/80 dark:text-amber-400/70">
              {t("sessions.resumeSkills.missingHint")}
            </span>
          </div>
        )}

        <p className="text-xs text-gray-400 dark:text-white/40">
          {changed
            ? t("sessions.resumeSkills.diff", { added, removed })
            : t("sessions.resumeSkills.unchanged")}
        </p>
      </div>
    </Modal>
  );
}
