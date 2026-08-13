import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, AnimateSpin, InfoIcon, StackIcon } from "neogestify-ui-components";
import { useMarketplaceStore } from "@/features/marketplace/store";
import type { RegistrySummary } from "@/features/marketplace/types";
import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";

interface RemoveRegistryDialogProps {
  registry: RegistrySummary;
  onClose: () => void;
}

/**
 * Confirmación de borrado de un repositorio.
 *
 * Borrar el repo se lleva puestas las skills que se instalaron desde él — su copia global
 * vive dentro de la carpeta de ese repo. Es una consecuencia que el usuario no tiene por
 * qué deducir, así que se listan por nombre antes de confirmar: una cosa es "elimino un
 * repo que ya no uso" y otra muy distinta es descubrir después que perdiste cinco skills
 * que tenías attacheadas a tus proyectos.
 */
export function RemoveRegistryDialog({ registry, onClose }: RemoveRegistryDialogProps) {
  const { t } = useTranslation();
  const { removeRegistry, registrySkills } = useMarketplaceStore();
  const loadInstalledSkills = useSkillsStore((s) => s.loadSkills);

  const [affected, setAffected] = useState<SkillSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    registrySkills(registry.id)
      .then((rows) => { if (!stale) setAffected(rows); })
      // Si no se pueden listar, se sigue pudiendo borrar — pero con la advertencia
      // genérica, nunca dando a entender que no hay nada que perder.
      .catch(() => { if (!stale) setAffected([]); });
    return () => { stale = true; };
  }, [registry.id, registrySkills]);

  const handleRemove = async () => {
    setBusy(true);
    setError("");
    try {
      await removeRegistry(registry.id);
      // El catálogo global cambió: sin esto, la página de Skills y el Marketplace seguirían
      // mostrando como instaladas las que se acaban de borrar.
      await loadInstalledSkills();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const loading = affected === null;
  const count = affected?.length ?? 0;

  return (
    <Modal
      title={t("marketplace.registries.remove")}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleRemove}
            disabled={busy || loading}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
            className="!bg-red-500 hover:!bg-red-600"
          >
            {count > 0
              ? t("marketplace.registries.removeWithSkills", { count })
              : t("marketplace.registries.removeConfirmAction")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <InfoIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("marketplace.registries.removeConfirm", { name: registry.name })}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
            <AnimateSpin className="w-3.5 h-3.5" />
            {t("marketplace.registries.removeChecking")}
          </div>
        ) : count === 0 ? (
          <p className="text-xs text-gray-400 dark:text-white/40">
            {t("marketplace.registries.removeNoSkills")}
          </p>
        ) : (
          <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg
            border border-red-200 dark:border-red-500/30
            bg-red-50 dark:bg-red-500/10">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase
              tracking-wide text-red-600 dark:text-red-400">
              <StackIcon className="w-3 h-3" />
              {t("marketplace.registries.removeSkillsTitle", { count })}
            </span>
            <ul className="cc-scroll flex flex-col gap-0.5 max-h-44 pr-1">
              {affected.map((s) => (
                <li key={s.id} className="flex items-baseline gap-2 text-xs text-red-700 dark:text-red-300">
                  <span className="truncate">{s.name}</span>
                  {/* Cuántos proyectos la usan ahora mismo: es el dato que convierte
                      "borro una skill" en "rompo tres tabs que la tienen attacheada". */}
                  {s.usedBy.length > 0 && (
                    <span className="text-[10px] text-red-500/80 dark:text-red-400/70 shrink-0">
                      {t("skills.list.usedBy", { count: s.usedBy.length })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <span className="text-[11px] text-red-600/80 dark:text-red-400/70">
              {t("marketplace.registries.removeSkillsHint")}
            </span>
          </div>
        )}

        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
