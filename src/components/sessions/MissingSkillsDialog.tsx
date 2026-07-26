import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "neogestify-ui-components";
import { AnimateSpin, CheckIcon, InfoIcon } from "neogestify-ui-components";
import { SessionSkillStatus } from "../../store/sessions";
import { useMarketplaceStore } from "../../store/marketplace";
import { useSkillsStore } from "../../store/skills";

interface MissingSkillsDialogProps {
  /** Título de la sesión que se está reabriendo, para dar contexto. */
  sessionTitle: string;
  statuses: SessionSkillStatus[];
  /** Sigue adelante con la reapertura, con las skills que haya en ese momento. */
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Advertencia previa a reabrir una sesión cuyas skills ya no están todas instaladas.
 * Cada faltante que algún repo habilitado ofrezca se puede reinstalar acá mismo; el resto
 * se listan igual, para que el usuario sepa con qué NO va a contar si sigue adelante.
 */
export function MissingSkillsDialog({
  sessionTitle,
  statuses,
  onContinue,
  onCancel,
}: MissingSkillsDialogProps) {
  const { t } = useTranslation();
  const installSkill = useMarketplaceStore((s) => s.installSkill);
  const loadSkills = useSkillsStore((s) => s.loadSkills);

  /** Nombres ya reinstalados en este diálogo (sin re-consultar al backend). */
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState("");

  const missing = statuses.filter((s) => !s.installedSkillId && !restored.has(s.name));
  const recoverable = missing.filter((s) => s.availableFrom);
  const unrecoverable = missing.filter((s) => !s.availableFrom);

  const install = async (status: SessionSkillStatus) => {
    if (!status.availableFrom) return;
    setInstalling(status.name);
    setError("");
    try {
      await installSkill(status.availableFrom.registryId, status.availableFrom.marketplaceSkillId);
      await loadSkills();
      setRestored((prev) => new Set(prev).add(status.name));
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  };

  const installAll = async () => {
    for (const s of recoverable) await install(s);
  };

  return (
    <Modal
      title={t("sessions.missingSkills.title")}
      onClose={onCancel}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("btn.cancel")}
          </Button>
          {recoverable.length > 0 && (
            <Button variant="outline" disabled={installing !== null} onClick={installAll}>
              {t("sessions.missingSkills.installAll")}
            </Button>
          )}
          <Button variant="primary" onClick={onContinue}>
            {missing.length === 0
              ? t("sessions.missingSkills.open")
              : t("sessions.missingSkills.continueAnyway")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {missing.length === 0
              ? t("sessions.missingSkills.allRestored", { session: sessionTitle })
              : t("sessions.missingSkills.body", { count: missing.length, session: sessionTitle })}
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {statuses.map((s) => {
            const isRestored = restored.has(s.name);
            const isPresent = Boolean(s.installedSkillId) || isRestored;
            return (
              <li
                key={s.name}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg
                  border border-gray-200 dark:border-gray-700
                  bg-gray-50 dark:bg-gray-800/50"
              >
                <div className="flex flex-col min-w-0 gap-0.5">
                  <span className={`text-sm font-medium truncate
                    ${isPresent
                      ? "text-gray-800 dark:text-gray-100"
                      : "text-amber-600 dark:text-amber-400"}`}>
                    {s.name}
                  </span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">
                    {isPresent
                      ? t("sessions.missingSkills.present")
                      : s.availableFrom
                        ? t("sessions.missingSkills.availableIn", { registry: s.availableFrom.registryName })
                        : t("sessions.missingSkills.notFound")}
                  </span>
                </div>

                {isPresent ? (
                  <CheckIcon className="w-4 h-4 shrink-0 text-emerald-500" />
                ) : s.availableFrom ? (
                  <Button
                    variant="outline"
                    className="!text-xs shrink-0"
                    disabled={installing !== null}
                    onClick={() => install(s)}
                    leftIcon={installing === s.name ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
                  >
                    {t("sessions.missingSkills.install")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {unrecoverable.length > 0 && (
          <p className="text-xs text-gray-400 dark:text-white/40">
            {t("sessions.missingSkills.notFoundHint")}
          </p>
        )}

        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
