import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import {
  SearchIcon, CloudIcon, AnimateSpin, CheckIcon, GearIcon, IconReset, FolderIcon,
} from "neogestify-ui-components";
import { useMarketplaceStore } from "@/features/marketplace/store";
import { useSkillsStore } from "@/features/skills/store";
import { PageHeader } from "@/shared/ui/PageHeader";

/** `null` = sin filtro, se muestran las skills de todos los repos habilitados. */
type RegistryFilter = string | null;

export function MarketplacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    registries, skills, loading, searchingRemote, installingKey, refreshingId,
    loadRegistries, loadSkills, searchRemote, installSkill, refreshRegistry,
  } = useMarketplaceStore();
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

  // Por nombre normalizado: el id del marketplace es el nombre de carpeta en el repo y el
  // de la copia instalada es un UUID, así que ninguno cruza. El `name` de las dos puntas sí
  // sale del mismo campo del frontmatter de SKILL.md.
  const installedNames = useMemo(
    () => new Set(installedSkills.map((s) => s.name.trim().toLowerCase())),
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
          {/* Sidebar: los repos como filtro. Es lo que se usa en cada visita, a diferencia
              del ABM, que vive en su propia pantalla detrás del botón de arriba.
              `sticky` desde md: con listas largas de skills, perder los filtros al
              scrollear obliga a volver arriba para cambiar de repo. */}
          <aside className="w-full md:w-56 lg:w-64 shrink-0 flex flex-col gap-2
            md:sticky md:top-10 md:self-start">
            <Button
              variant="outline"
              onClick={() => navigate("/marketplace/registries")}
              className="!text-xs flex items-center justify-center gap-1.5 w-full"
            >
              <GearIcon className="w-3.5 h-3.5" />
              {t("marketplace.manageRegistries")}
            </Button>

            <nav className="rounded-xl border border-gray-200 dark:border-gray-700
              bg-white dark:bg-gray-800/50 overflow-hidden">
              <span className="block px-3 py-2 text-[11px] font-semibold uppercase tracking-wide
                text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-white/5
                bg-gray-50/60 dark:bg-white/[0.02]">
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
                      onClick={() => setSelectedRegistry(null)}
                      className={`flex items-center justify-between gap-2 w-full px-2 py-1.5 rounded-lg text-xs
                        transition-colors
                        ${selectedRegistry === null
                          ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium"
                          : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5"}`}
                    >
                      <span className="truncate">{t("marketplace.allRegistries")}</span>
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                        {skills.length}
                      </span>
                    </button>
                  </li>

                  {registries.map((r) => {
                    const active = selectedRegistry === r.id;
                    const refreshing = refreshingId === r.id;
                    return (
                      <li key={r.id} className="flex items-center gap-0.5">
                        <button
                          onClick={() => setSelectedRegistry(r.id)}
                          // Su conteo es el de la última búsqueda, no su tamaño: sin esto,
                          // un 0 al lado de skills.sh se lee como repositorio roto.
                          title={
                            r.sourceType === "skillssh"
                              ? t("marketplace.registries.skillsShNotListable")
                              : r.location
                          }
                          className={`flex items-center gap-1.5 min-w-0 flex-1 px-2 py-1.5 rounded-lg text-xs
                            transition-colors
                            ${active
                              ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium"
                              : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5"}
                            ${r.enabled ? "" : "opacity-50"}`}
                        >
                          {r.sourceType === "local"
                            ? <FolderIcon className="w-3 h-3 shrink-0" />
                            : <CloudIcon className="w-3 h-3 shrink-0" />}
                          <span className="truncate flex-1 text-left">{r.name}</span>
                          <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                            {countByRegistry.get(r.id) ?? 0}
                          </span>
                        </button>
                        {/* Refrescar acá mismo: si un repo se ve desactualizado mientras
                            navegás sus skills, no tiene sentido mandarte a otra pantalla. */}
                        <Button
                          variant="icon"
                          disabled={refreshing}
                          onClick={() => handleRefresh(r.id)}
                          title={t("marketplace.registries.refresh")}
                          className="!p-1 shrink-0"
                        >
                          {refreshing
                            ? <AnimateSpin className="w-3 h-3" />
                            : <IconReset className="w-3 h-3" />}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </nav>
          </aside>

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
                  const installed = installedNames.has(skill.name.trim().toLowerCase());
                  const installing = installingKey === key;
                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-3 px-4 py-3 rounded-xl border
                        border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50
                        hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm
                        transition-all"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex items-center justify-center w-9 h-9 rounded-full shrink-0
                          bg-violet-50 dark:bg-violet-500/10 text-violet-500 dark:text-violet-400">
                          <CloudIcon className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate block">
                            {skill.name}
                          </span>
                          <span className="flex flex-wrap items-center gap-1">
                            {/* `max-w-full` + `truncate`: el nombre de un repo puede ser
                                largo (una URL de GitHub completa) y sin esto estira el badge
                                más allá de la tarjeta. */}
                            <span className="max-w-full truncate text-[10px] font-mono px-1.5 py-0.5 rounded-full
                              bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
                              {skill.registryName}
                            </span>
                            {/* El botón ya lo dice, pero deshabilitado se lee poco: en una
                                grilla conviene algo que se note al barrer con la vista. */}
                            {/* Las skills de skills.sh no traen descripción, así que las
                                instalaciones son la única señal para comparar entre
                                resultados parecidos. */}
                            {skill.installs && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full
                                bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                {t("marketplace.installs", { count: skill.installs })}
                              </span>
                            )}
                            {installed && (
                              <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full
                                bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                <CheckIcon className="w-2.5 h-2.5" />
                                {t("marketplace.installed")}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>

                      {skill.description && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">
                          {skill.description}
                        </p>
                      )}
                      {skill.categories.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {skill.categories.map((c) => (
                            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full
                              bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                              {c}
                            </span>
                          ))}
                        </span>
                      )}

                      <Button
                        variant={installed ? "outline" : "primary"}
                        disabled={installed || installing}
                        onClick={() => handleInstall(skill.registryId, skill.id)}
                        className="!text-xs flex items-center justify-center gap-1.5 mt-auto"
                      >
                        {installing && <AnimateSpin className="w-3 h-3" />}
                        {installed
                          ? t("marketplace.installed")
                          : installing
                            ? t("marketplace.installing")
                            : t("marketplace.install")}
                      </Button>
                    </div>
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
