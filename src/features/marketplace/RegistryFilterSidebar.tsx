import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CloudIcon, FolderIcon, GearIcon, IconReset } from "neogestify-ui-components";

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

  const itemClass = (active: boolean) =>
    `transition-colors ${
      active
        ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium"
        : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5"
    }`;

  return (
    // `sticky` desde md: con listas largas de skills, perder los filtros al scrollear
    // obliga a volver arriba para cambiar de repo.
    <aside
      className="w-full md:w-56 lg:w-64 shrink-0 flex flex-col gap-2
        md:sticky md:top-10 md:self-start"
    >
      <Button
        variant="outline"
        onClick={() => navigate("/marketplace/registries")}
        className="!text-xs flex items-center justify-center gap-1.5 w-full"
      >
        <GearIcon className="w-3.5 h-3.5" />
        {t("marketplace.manageRegistries")}
      </Button>

      <nav
        className="rounded-xl border border-gray-200 dark:border-gray-700
          bg-white dark:bg-gray-800/50 overflow-hidden"
      >
        <span
          className="block px-3 py-2 text-[11px] font-semibold uppercase tracking-wide
            text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-white/5
            bg-gray-50/60 dark:bg-white/[0.02]"
        >
          {t("marketplace.registries")}
        </span>

        {registries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500">
            {t("marketplace.registries.empty")}
          </p>
        ) : (
          <ul className="flex flex-col p-1.5 gap-0.5">
            <li>
              <button
                onClick={() => onSelect(null)}
                className={`flex items-center justify-between gap-2 w-full px-2 py-1.5 rounded-lg text-xs ${itemClass(selected === null)}`}
              >
                <span className="truncate">{t("marketplace.allRegistries")}</span>
                <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                  {totalCount}
                </span>
              </button>
            </li>

            {registries.map((r) => {
              const refreshing = refreshingId === r.id;
              return (
                <li key={r.id} className="flex items-center gap-0.5">
                  <button
                    onClick={() => onSelect(r.id)}
                    // Su conteo es el de la última búsqueda, no su tamaño: sin esto, un 0
                    // al lado de skills.sh se lee como repositorio roto.
                    title={
                      r.sourceType === "skillssh"
                        ? t("marketplace.registries.skillsShNotListable")
                        : r.location
                    }
                    className={`flex items-center gap-1.5 min-w-0 flex-1 px-2 py-1.5 rounded-lg text-xs
                      ${itemClass(selected === r.id)} ${r.enabled ? "" : "opacity-50"}`}
                  >
                    {r.sourceType === "local" ? (
                      <FolderIcon className="w-3 h-3 shrink-0" />
                    ) : (
                      <CloudIcon className="w-3 h-3 shrink-0" />
                    )}
                    <span className="truncate flex-1 text-left">{r.name}</span>
                    <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                      {countByRegistry.get(r.id) ?? 0}
                    </span>
                  </button>
                  {/* Refrescar acá mismo: si un repo se ve desactualizado mientras navegás
                      sus skills, no tiene sentido mandarte a otra pantalla. */}
                  <Button
                    variant="icon"
                    disabled={refreshing}
                    onClick={() => onRefresh(r.id)}
                    title={t("marketplace.registries.refresh")}
                    className="!p-1 shrink-0"
                  >
                    {refreshing ? (
                      <AnimateSpin className="w-3 h-3" />
                    ) : (
                      <IconReset className="w-3 h-3" />
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
