import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import {
  SearchIcon, CloudIcon, AnimateSpin,
} from "neogestify-ui-components";
import { useMarketplaceStore } from "@/features/marketplace/store";
import { useSkillsStore } from "@/features/skills/store";
import { PageHeader } from "@/shared/ui/PageHeader";

import { MarketplaceSkillCard } from "./MarketplaceSkillCard";
import { RegistryFilterSidebar, type RegistryFilter } from "./RegistryFilterSidebar";

export function MarketplacePage() {
  const { t } = useTranslation();
  const registries = useMarketplaceStore((s) => s.registries);
  const skills = useMarketplaceStore((s) => s.skills);
  const loading = useMarketplaceStore((s) => s.loading);
  const searchingRemote = useMarketplaceStore((s) => s.searchingRemote);
  const installingKey = useMarketplaceStore((s) => s.installingKey);
  const refreshingId = useMarketplaceStore((s) => s.refreshingId);
  const loadRegistries = useMarketplaceStore((s) => s.loadRegistries);
  const loadSkills = useMarketplaceStore((s) => s.loadSkills);
  const searchRemote = useMarketplaceStore((s) => s.searchRemote);
  const installSkill = useMarketplaceStore((s) => s.installSkill);
  const refreshRegistry = useMarketplaceStore((s) => s.refreshRegistry);
  const [query, setQuery] = useState("");
  const [selectedRegistry, setSelectedRegistry] = useState<RegistryFilter>(null);
  const [error, setError] = useState<string | null>(null);

  // Lo que YA está instalado sale del catálogo global real, no de un estado local de la
  // página: si no, al entrar todo aparece como "Instalar" aunque ya lo tengas, y volver a
  // instalarlo deja dos copias de la misma skill.
  const installedSkills = useSkillsStore((s) => s.skills);
  const loadInstalledSkills = useSkillsStore((s) => s.loadSkills);

  useEffect(() => {
    loadRegistries();
    loadSkills();
    loadInstalledSkills();
  }, [loadRegistries, loadSkills, loadInstalledSkills]);

  useEffect(() => {
    const handle = setTimeout(() => loadSkills(query), 250);
    return () => clearTimeout(handle);
  }, [query, loadSkills]);

  // skills.sh se consulta SIEMPRE, junto con el resto: buscar en el Marketplace tiene que
  // mostrar todo lo que hay, sin que el usuario tenga que decidir cuándo mirar cada fuente.
  //
  // Va en su propio efecto y con más espera que el filtro local porque cada disparo arranca
  // un proceso `npx` que tarda segundos: la espera es para no lanzar uno por tecla, no para
  // que el usuario tenga que pedirlo.
  useEffect(() => {
    const handle = setTimeout(() => searchRemote(query), 700);
    return () => clearTimeout(handle);
  }, [query, searchRemote]);

  // Por (repositorio, entrada de origen), NUNCA por nombre.
  //
  // El bug que esto arregla: había un `Set` de nombres, así que instalar `testing` de un
  // repo marcaba como instalada la `testing` de todos los demás y te desactivaba el botón
  // de una skill que no tenías. Y no es un caso raro — en un directorio como skills.sh el
  // mismo nombre lo usan publicadores distintos para cosas distintas.
  const installedOrigins = useMemo(
    () =>
      new Set(
        installedSkills
          .filter((s) => s.registryId && s.originSkillId)
          .map((s) => `${s.registryId}\u0000${s.originSkillId}`)
      ),
    [installedSkills]
  );

  // Todo lo que se ve viene de un repo que solo responde a búsquedas, y todavía no hay
  // ninguna: el vacío se explica solo, no hay nada que arreglar.
  const remoteNeedsQuery = useMemo(() => {
    if (query.trim().length >= 2) return false;
    const relevant = selectedRegistry
      ? registries.filter((r) => r.id === selectedRegistry)
      : registries.filter((r) => r.enabled);
    return relevant.length > 0 && relevant.every((r) => r.sourceType === "skillssh");
  }, [query, selectedRegistry, registries]);

  const hasSkillsSh = useMemo(
    () => registries.some((r) => r.sourceType === "skillssh" && r.enabled),
    [registries]
  );

  const visible = useMemo(
    () => (selectedRegistry ? skills.filter((s) => s.registryId === selectedRegistry) : skills),
    [skills, selectedRegistry]
  );

  /** Cuántas skills aporta cada repo al listado actual — el conteo del sidebar. */
  const countByRegistry = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of skills) counts.set(s.registryId, (counts.get(s.registryId) ?? 0) + 1);
    return counts;
  }, [skills]);

  const handleInstall = async (registryId: string, skillId: string) => {
    setError(null);
    try {
      await installSkill(registryId, skillId);
      await loadInstalledSkills();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRefresh = async (id: string) => {
    await refreshRegistry(id);
  };

  // Ancho completo, sin `max-w` centrado: el sidebar ocupa el margen izquierdo que antes
  // quedaba vacío, y las cards se llevan todo el resto. En una grilla de tarjetas el ancho
  // extra se traduce en más columnas y tarjetas más grandes, no en líneas de texto
  // incómodas de leer — que es el motivo por el que el ABM de repositorios sí conserva su
  // `max-w`.
  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="w-full">
        <PageHeader
          icon={<CloudIcon className="w-5 h-5" />}
          title={t("marketplace.title")}
          subtitle={t("marketplace.subtitle")}
        />

        {/* `flex-col` hasta `md`: en pantallas angostas el orden del DOM manda, así que los
            filtros aparecen arriba y las skills debajo, sin apretar ninguna de las dos
            columnas contra el borde. */}
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <RegistryFilterSidebar
            registries={registries}
            selected={selectedRegistry}
            onSelect={setSelectedRegistry}
            countByRegistry={countByRegistry}
            totalCount={skills.length}
            refreshingId={refreshingId}
            onRefresh={handleRefresh}
          />

          {/* Skills remotas */}
          <div className="flex-1 min-w-0 w-full">
            <div className="mb-4">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("marketplace.searchPlaceholder")}
                variant="outline"
                icon={<SearchIcon className="w-4 h-4" />}
                clearable
                onClear={() => setQuery("")}
              />

              {/* Por qué skills.sh puede figurar en 0 aunque lo refresques: no es que esté
                  roto ni desactualizado, es que su directorio no se puede enumerar. Se dice
                  acá, junto al buscador, que es donde el usuario se lo pregunta. */}
              {hasSkillsSh && query.trim().length < 2 && (
                <p className="mt-2 px-1 text-xs text-gray-400 dark:text-gray-500">
                  {t("marketplace.skillsShNeedsQuery")}
                </p>
              )}
            </div>

            {error && <p className="text-sm text-red-500 dark:text-red-400 mb-4 px-1">{error}</p>}

            {/* La búsqueda en skills.sh NO vacía la grilla: los repos con cache ya
                respondieron y tapar esos resultados durante los segundos que tarda `npx`
                haría parecer que la búsqueda "se reinicia" en cada consulta. Se avisa que
                sigue trabajando y los resultados del directorio se suman al llegar. */}
            {searchingRemote && (
              <div className="flex items-center gap-2 mb-3 px-1 text-xs
                text-gray-400 dark:text-gray-500">
                <AnimateSpin className="w-3 h-3" />
                {t("marketplace.searchingRemote")}
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm
                text-gray-400 dark:text-gray-500">
                <AnimateSpin className="w-4 h-4" />
                {t("marketplace.loading")}
              </div>
            ) : visible.length === 0 && !searchingRemote ? (
              <div className="flex flex-col items-center gap-2 py-14 text-gray-400 dark:text-gray-500">
                <CloudIcon className="w-8 h-8 opacity-30" />
                <p className="text-sm text-center max-w-xs">
                  {/* Un repo de skills.sh vacío no está roto ni desactualizado: es que
                      todavía no se buscó nada. Decirlo evita que parezca lo primero. */}
                  {remoteNeedsQuery
                    ? t("marketplace.remoteNeedsQuery")
                    : selectedRegistry
                      ? t("marketplace.emptyForRegistry")
                      : t("marketplace.empty")}
                </p>
                {selectedRegistry && (
                  <Button variant="outline" onClick={() => setSelectedRegistry(null)} className="!text-xs">
                    {t("marketplace.allRegistries")}
                  </Button>
                )}
              </div>
            ) : (
              // Se suman columnas a medida que hay ancho real, en vez de estirar dos
              // tarjetas gigantes: el salto arranca en `sm` porque a partir de ahí ya
              // sobra lugar aunque el sidebar esté al costado.
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4
                gap-4 items-start">
                {visible.map((skill) => {
                  const key = `${skill.registryId}:${skill.id}`;
                  return (
                    <MarketplaceSkillCard
                      key={key}
                      skill={skill}
                      installed={installedOrigins.has(`${skill.registryId}\u0000${skill.id}`)}
                      installing={installingKey === key}
                      onInstall={() => handleInstall(skill.registryId, skill.id)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
