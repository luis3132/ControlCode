import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, AddIcon, CloudIcon, AnimateSpin, ArrowLeftIcon } from "neogestify-ui-components";
import { useMarketplaceStore } from "@/features/marketplace/store";
import { AddRegistryDialog } from "@/features/marketplace/AddRegistryDialog";
import { RegistryRow } from "@/features/marketplace/RegistryRow";
import { PageHeader } from "@/shared/ui/PageHeader";

/**
 * Gestión de repositorios de skills: agregar, renombrar, activar/desactivar, refrescar y
 * borrar.
 *
 * Vive fuera del Marketplace a propósito. Antes la lista completa ocupaba el tercio
 * superior de la página de skills remotas, empujando abajo lo que uno viene a ver — y es
 * una pantalla de administración, algo que se toca de vez en cuando, no en cada visita. En
 * el Marketplace quedan los repos como filtros (que sí se usan siempre) y un botón que
 * trae acá.
 */
export function RegistriesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const registries = useMarketplaceStore((s) => s.registries);
  const loadRegistries = useMarketplaceStore((s) => s.loadRegistries);
  const loadSkills = useMarketplaceStore((s) => s.loadSkills);
  const refreshAll = useMarketplaceStore((s) => s.refreshAll);
  const [addOpen, setAddOpen] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);

  useEffect(() => {
    loadRegistries();
  }, [loadRegistries]);

  const handleRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      await refreshAll();
      await loadSkills();
    } finally {
      setRefreshingAll(false);
    }
  };

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto">
        <Button
          variant="link"
          onClick={() => navigate("/marketplace")}
          className="!text-xs flex items-center gap-1 mb-3"
        >
          <ArrowLeftIcon className="w-3.5 h-3.5" />
          {t("marketplace.registries.backToMarketplace")}
        </Button>

        <PageHeader
          icon={<CloudIcon className="w-5 h-5" />}
          title={t("marketplace.registries.pageTitle")}
          subtitle={t("marketplace.registries.pageSubtitle")}
          action={
            <Button
              variant="primary"
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-1.5 !text-sm w-fit"
            >
              <AddIcon className="w-4 h-4" />
              {t("marketplace.addRegistry")}
            </Button>
          }
        />

        <section className="rounded-xl border border-gray-200 dark:border-gray-700
          bg-white dark:bg-gray-800/50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5
            border-b border-gray-100 dark:border-white/5 bg-gray-50/60 dark:bg-white/[0.02]">
            <span className="text-xs font-semibold uppercase tracking-wide
              text-gray-500 dark:text-gray-400">
              {t("marketplace.registries")}
              {registries.length > 0 && (
                <span className="ml-1.5 font-normal normal-case text-gray-400 dark:text-gray-500">
                  ({registries.length})
                </span>
              )}
            </span>
            {registries.length > 0 && (
              <Button
                variant="link"
                onClick={handleRefreshAll}
                disabled={refreshingAll}
                className="!text-xs flex items-center gap-1.5"
              >
                {refreshingAll && <AnimateSpin className="w-3 h-3" />}
                {t("marketplace.refreshAll")}
              </Button>
            )}
          </div>

          {registries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 px-4 text-center">
              <CloudIcon className="w-6 h-6 text-gray-300 dark:text-white/15" />
              <p className="text-sm text-gray-400 dark:text-gray-500">
                {t("marketplace.registries.empty")}
              </p>
              <Button variant="outline" onClick={() => setAddOpen(true)} className="!text-xs mt-1">
                {t("marketplace.addRegistry")}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-white/5">
              {registries.map((r) => (
                <RegistryRow key={r.id} registry={r} />
              ))}
            </ul>
          )}
        </section>

        <p className="mt-4 text-[11px] text-gray-400 dark:text-white/40">
          {t("marketplace.registries.deleteHint")}
        </p>
      </div>

      {addOpen && <AddRegistryDialog onClose={() => setAddOpen(false)} />}
    </main>
  );
}
