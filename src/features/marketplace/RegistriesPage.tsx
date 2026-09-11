import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AddIcon,
  AnimateSpin,
  ArrowLeftIcon,
  Button,
  CloudIcon,
  EmptyState,
  IconReset,
  Tooltip,
} from "neogestify-ui-components";

import { useMarketplaceStore } from "@/features/marketplace/store";
import { AddRegistryDialog } from "@/features/marketplace/AddRegistryDialog";
import { RegistryRow } from "@/features/marketplace/RegistryRow";

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
    <div className="flex flex-col h-full min-h-0">

      <div className="flex items-center gap-3 h-[54px] shrink-0 pl-4 pr-14
        border-b border-gray-200 dark:border-white/8">
        <Tooltip content={t("marketplace.registries.backToMarketplace")} placement="bottom">
          <button
            onClick={() => navigate("/marketplace")}
            aria-label={t("marketplace.registries.backToMarketplace")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <ArrowLeftIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <CloudIcon className="w-[15px] h-[15px] shrink-0 text-blue-500 dark:text-blue-400" />
        <span className="flex-1 min-w-0 truncate text-[13.5px] font-bold
          text-gray-900 dark:text-white">
          {t("marketplace.registries.pageTitle")}
        </span>
        {registries.length > 0 && (
          <Tooltip content={t("marketplace.refreshAll")} placement="bottom">
            <button
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              aria-label={t("marketplace.refreshAll")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                text-gray-400 dark:text-white/35
                hover:text-gray-700 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10
                disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {refreshingAll
                ? <AnimateSpin className="w-3.5 h-3.5" />
                : <IconReset className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={t("marketplace.addRegistry")} placement="bottom">
          <button
            onClick={() => setAddOpen(true)}
            aria-label={t("marketplace.addRegistry")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <AddIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll py-1.5">
        {registries.length === 0 ? (
          <EmptyState
            className="py-14"
            icon={<CloudIcon className="w-8 h-8" />}
            title={t("marketplace.registries.empty")}
            action={
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                {t("marketplace.addRegistry")}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-white/6">
            {registries.map((r) => (
              <RegistryRow key={r.id} registry={r} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20
        text-[10.5px] text-gray-400 dark:text-white/35">
        <span className="tabular-nums shrink-0">
          {t("marketplace.registries.count", { n: registries.length })}
        </span>
        <span className="flex-1 truncate">{t("marketplace.registries.deleteHint")}</span>
      </div>

      {addOpen && <AddRegistryDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}
