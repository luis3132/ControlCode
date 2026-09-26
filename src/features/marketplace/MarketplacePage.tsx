import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Badge, Button, CloudIcon, Skeleton } from "neogestify-ui-components";
import { useMarketplaceStore } from "@/features/marketplace/store";
import { useSkillsStore } from "@/features/skills/store";
import { Markdown } from "@/shared/ui/Markdown";

import { SkillResultRow } from "./SkillResultRow";
import { useSkillReadme } from "./useSkillReadme";
import { flatOrder, groupByRegistry, keyOf } from "./palette";
import { moveSelection, reconcileSelection, useSelectionVisible } from "@/shared/ui/paletteNav";
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
  /** Lo marcado en la lista, por `keyOf`. Manda el teclado tanto como el mouse. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  // Va en su propio efecto y con más espera que el filtro local porque cada disparo sale a
  // internet: la espera es para no lanzar una búsqueda por tecla, no para que el usuario
  // tenga que pedirlo.
  useEffect(() => {
    // Al terminar se relee el catálogo instalado. La búsqueda es lo que le deja al backend
    // el cache del repositorio, y con ese cache puede reconocer las instalaciones viejas
    // que no sabían de qué entrada salieron (ver `link_orphan_installs`). Sin esta
    // relectura, esas filas seguirían apareciendo como no instaladas hasta el próximo
    // arranque — que es lo que llevaba a instalarlas de nuevo y terminar con dos copias.
    const handle = setTimeout(
      () => searchRemote(query).then(() => loadInstalledSkills()).catch(() => {}),
      700
    );
    return () => clearTimeout(handle);
  }, [query, searchRemote, loadInstalledSkills]);

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

  const groups = useMemo(() => groupByRegistry(visible), [visible]);
  const order = useMemo(() => flatOrder(groups), [groups]);

  // La lista se rehace con cada tecla: lo marcado se conserva si sigue estando, y si no
  // pasa a ser lo primero. Dejarlo apuntando a algo que ya no se ve haría que Enter
  // instalara una skill que el usuario no tiene delante.
  useEffect(() => {
    setSelectedKey((current) => reconcileSelection(order.map(keyOf), current));
  }, [order]);

  const selected = useMemo(
    () => order.find((s) => keyOf(s) === selectedKey) ?? null,
    [order, selectedKey]
  );

  const selectedRef = useSelectionVisible<HTMLDivElement>(selectedKey);
  const readme = useSkillReadme(selected?.registryId ?? null, selected?.id ?? null);
  const sourceTypeOf = useCallback(
    (registryId: string) => registries.find((r) => r.id === registryId)?.sourceType,
    [registries]
  );

  const isInstalled = (skill: { registryId: string; id: string }) =>
    installedOrigins.has(`${skill.registryId}\u0000${skill.id}`);

  // El foco arranca en el buscador: esto es una paleta, se llega escribiendo.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedKey((current) => moveSelection(order.map(keyOf), current, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter" && selected && !isInstalled(selected)) {
      e.preventDefault();
      handleInstall(selected.registryId, selected.id);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <RegistryFilterSidebar
        registries={registries}
        selected={selectedRegistry}
        onSelect={setSelectedRegistry}
        countByRegistry={countByRegistry}
        totalCount={skills.length}
        refreshingId={refreshingId}
        onRefresh={handleRefresh}
      />

      {/* ══ la lista ══════════════════════════════════════════════════════ */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center gap-3 h-[54px] shrink-0 pl-4 pr-14
          border-b border-gray-200 dark:border-white/8">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
            className="shrink-0 text-blue-500 dark:text-blue-400">
            <path d="M5 7l5 5-5 5M13 17h6" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("marketplace.searchPlaceholder")}
            className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[15px]
              text-gray-900 dark:text-white
              placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
          {searchingRemote && <AnimateSpin className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
          {selectedRegistry && (
            <Badge variant="accent" size="sm" className="shrink-0">
              {registries.find((r) => r.id === selectedRegistry)?.name ?? ""}
            </Badge>
          )}
        </div>

        <div className="flex-1 min-h-0 cc-scroll py-1.5">
          {error && <div className="px-3 pb-2"><Alert variant="danger">{error}</Alert></div>}

          {loading && order.length === 0 ? (
            <div className="flex flex-col gap-2 px-4 py-2">
              {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} variant="rounded" height={42} />)}
            </div>
          ) : order.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-gray-400 dark:text-white/30">
              <CloudIcon className="w-8 h-8 opacity-30" />
              <p className="text-sm text-center max-w-xs px-6">
                {remoteNeedsQuery ? t("marketplace.skillsShNeedsQuery") : t("marketplace.empty")}
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.registryId}>
                <div className="flex items-center gap-2.5 px-4 pt-3 pb-1">
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                    text-gray-400 dark:text-white/30">
                    {group.registryName}
                  </span>
                  <span className="flex-1 h-px bg-gray-200 dark:bg-white/6" />
                </div>
                {group.items.map((skill) => (
                  <SkillResultRow
                    key={keyOf(skill)}
                    skill={skill}
                    sourceType={sourceTypeOf(skill.registryId)}
                    selected={keyOf(skill) === selectedKey}
                    rowRef={keyOf(skill) === selectedKey ? selectedRef : undefined}
                    installed={isInstalled(skill)}
                    installing={installingKey === `${skill.registryId}:${skill.id}`}
                    onSelect={() => setSelectedKey(keyOf(skill))}
                    onInstall={() => handleInstall(skill.registryId, skill.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
          border-t border-gray-200 dark:border-white/8
          bg-gray-100/60 dark:bg-black/20
          text-[10.5px] text-gray-400 dark:text-white/35">
          <span><b className="text-gray-500 dark:text-gray-400">↵</b> {t("marketplace.key.install")}</span>
          <span><b className="text-gray-500 dark:text-gray-400">↑↓</b> {t("marketplace.key.move")}</span>
          <div className="flex-1" />
          <span><b className="text-gray-500 dark:text-gray-400">esc</b> {t("marketplace.key.close")}</span>
        </div>
      </div>

      {/* ══ la skill elegida, con su SKILL.md renderizado ═════════════════ */}
      <aside className="flex flex-col w-[21rem] shrink-0 min-h-0
        border-l border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/20">
        {!selected ? (
          <p className="px-5 py-8 text-[11.5px] text-center text-gray-400 dark:text-white/30">
            {t("marketplace.preview.none")}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1 shrink-0 px-5 pt-5 pb-3">
              <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">
                {selected.name}
              </span>
              <span className="text-[10.5px] font-mono text-gray-400 dark:text-white/35">
                {[selected.author, selected.registryName].filter(Boolean).join(" · ")}
              </span>
              {selected.categories.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selected.categories.map((c) => (
                    <Badge key={c} variant="neutral" size="sm">{c}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 cc-scroll px-5 pb-4">
              {readme.loading ? (
                <Skeleton variant="text" lines={8} />
              ) : readme.content ? (
                <Markdown content={readme.content} />
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-[12.5px] leading-relaxed text-gray-600 dark:text-gray-400">
                    {selected.description ?? t("marketplace.preview.noDescription")}
                  </p>
                  {readme.unavailable && (
                    <p className="text-[11px] text-gray-400 dark:text-white/30">
                      {t("marketplace.preview.unavailable")}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 px-5 py-3 border-t border-gray-200 dark:border-white/8">
              <Button
                variant={isInstalled(selected) ? "outline" : "primary"}
                fullWidth
                disabled={isInstalled(selected) || installingKey !== null}
                isLoading={installingKey === `${selected.registryId}:${selected.id}`}
                onClick={() => handleInstall(selected.registryId, selected.id)}
              >
                {isInstalled(selected) ? t("marketplace.installed") : t("marketplace.install")}
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
