import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimateSpin, CloudIcon, FolderIcon, GearIcon, IconReset, Tooltip } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { PanelIcon } from "@/app/icons";

import type { RegistrySummary } from "./types";

/** `null` = sin filtro, se muestran las skills de todos los repos habilitados. */
export type RegistryFilter = string | null;

/**
 * Los repos como filtro lateral. Es lo que se usa en cada visita, a diferencia del ABM,
 * que vive en su propia pantalla detrás del botón de arriba.
 */
export function RegistryFilterSidebar({
  registries,
  selected,
  onSelect,
  countByRegistry,
  totalCount,
  refreshingId,
  onRefresh,
}: {
  registries: RegistrySummary[];
  selected: RegistryFilter;
  onSelect: (id: RegistryFilter) => void;
  /** Cuántas skills aporta cada repo al listado actual. */
  countByRegistry: Map<string, number>;
  totalCount: number;
  refreshingId: string | null;
  onRefresh: (id: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const collapsed = useUiStore((s) => s.marketplaceReposCollapsed);
  const toggle = useUiStore((s) => s.toggleMarketplaceRepos);

  const itemClass = (active: boolean) =>
    `cc-t ${
      active
        ? "bg-violet-500/12 text-violet-600 dark:text-violet-400 font-semibold"
        : "text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/6"
    }`;

  /** Botón de icono del encabezado, igual que el del resto de los paneles. */
  const headBtn = `cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
    text-gray-400 dark:text-white/35
    hover:text-gray-700 dark:hover:text-white
    hover:bg-gray-200 dark:hover:bg-white/10`;

  // Plegado queda una columna de iconos, igual que el explorador: la grilla se lleva esos
  // píxeles, que a 1440 son una tarjeta más por fila. El estado se recuerda.
  if (collapsed) {
    return (
      <aside className="cc-fade flex flex-col items-center gap-1 w-11 shrink-0 pt-2
        border-r border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/20">
        <Tooltip content={t("marketplace.registries.expand")} placement="right">
          <button
            onClick={toggle}
            aria-label={t("marketplace.registries.expand")}
            className="cc-t relative flex items-center justify-center w-8 h-8 rounded-lg
              text-gray-500 dark:text-white/40
              hover:text-gray-900 dark:hover:text-white
              hover:bg-gray-200/60 dark:hover:bg-white/8"
          >
            <PanelIcon className="w-4 h-4" />
            {selected !== null && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-violet-500" />
            )}
          </button>
        </Tooltip>
        <Tooltip content={t("marketplace.manageRegistries")} placement="right">
          <button
            onClick={() => navigate("/marketplace/registries")}
            aria-label={t("marketplace.manageRegistries")}
            className="cc-t flex items-center justify-center w-8 h-8 rounded-lg
              text-gray-500 dark:text-white/40
              hover:text-gray-900 dark:hover:text-white
              hover:bg-gray-200/60 dark:hover:bg-white/8"
          >
            <GearIcon className="w-4 h-4" />
          </button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="cc-fade flex flex-col w-56 shrink-0 min-h-0
      border-r border-gray-200 dark:border-white/8
      bg-gray-100/50 dark:bg-black/20">

      <div className="flex items-center gap-1 h-8 shrink-0 pl-3 pr-1.5
        border-b border-gray-200 dark:border-white/8">
        <span className="flex-1 min-w-0 truncate text-[10.5px] font-bold uppercase
          tracking-[0.09em] text-gray-500 dark:text-gray-400">
          {t("marketplace.registries")}
        </span>
        <Tooltip content={t("marketplace.manageRegistries")} placement="bottom">
          <button
            onClick={() => navigate("/marketplace/registries")}
            aria-label={t("marketplace.manageRegistries")}
            className={headBtn}
          >
            <GearIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t("marketplace.registries.collapse")} placement="bottom">
          <button onClick={toggle} aria-label={t("marketplace.registries.collapse")} className={headBtn}>
            <PanelIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <nav className="flex-1 min-h-0 cc-scroll p-1.5">
        {registries.length === 0 ? (
          <p className="px-2 py-4 text-[11.5px] text-gray-400 dark:text-white/30">
            {t("marketplace.registries.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                onClick={() => onSelect(null)}
                className={`flex items-center justify-between gap-2 w-full h-7 px-2 rounded-lg
                  text-[11.5px] ${itemClass(selected === null)}`}
              >
                <span className="truncate">{t("marketplace.allRegistries")}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">
                  {totalCount}
                </span>
              </button>
            </li>

            {registries.map((r) => {
              const refreshing = refreshingId === r.id;
              return (
                <li key={r.id} className="group flex items-center gap-0.5">
                  <button
                    onClick={() => onSelect(r.id)}
                    // Su conteo es el de la última búsqueda, no su tamaño: sin esto, un 0
                    // al lado de skills.sh se lee como repositorio roto.
                    title={
                      r.sourceType === "skillssh"
                        ? t("marketplace.registries.skillsShNotListable")
                        : r.location
                    }
                    className={`flex items-center gap-1.5 min-w-0 flex-1 h-7 px-2 rounded-lg
                      text-[11.5px] ${itemClass(selected === r.id)} ${r.enabled ? "" : "opacity-50"}`}
                  >
                    {r.sourceType === "local"
                      ? <FolderIcon className="w-3 h-3 shrink-0" />
                      : <CloudIcon className="w-3 h-3 shrink-0" />}
                    <span className="flex-1 min-w-0 truncate text-left">{r.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">
                      {countByRegistry.get(r.id) ?? 0}
                    </span>
                  </button>
                  {/* Refrescar acá mismo: si un repo se ve desactualizado mientras navegás
                      sus skills, no tiene sentido mandarte a otra pantalla. */}
                  <Tooltip content={t("marketplace.registries.refresh")} placement="right">
                    <button
                      disabled={refreshing}
                      onClick={() => onRefresh(r.id)}
                      aria-label={t("marketplace.registries.refresh")}
                      className="cc-t flex items-center justify-center w-5 h-5 rounded shrink-0
                        opacity-0 group-hover:opacity-100 disabled:opacity-100
                        text-gray-400 dark:text-white/35
                        hover:text-gray-700 dark:hover:text-white
                        hover:bg-gray-200 dark:hover:bg-white/10"
                    >
                      {refreshing
                        ? <AnimateSpin className="w-3 h-3" />
                        : <IconReset className="w-3 h-3" />}
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
