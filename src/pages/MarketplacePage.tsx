import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import { AddIcon, SearchIcon, CloudIcon, AnimateSpin } from "neogestify-ui-components";
import { useMarketplaceStore } from "../store/marketplace";
import { AddRegistryDialog } from "../components/marketplace/AddRegistryDialog";
import { RegistryRow } from "../components/marketplace/RegistryRow";
import { PageHeader } from "../components/common/PageHeader";

export function MarketplacePage() {
  const { t } = useTranslation();
  const {
    registries, skills, loading, installingKey,
    loadRegistries, loadSkills, refreshAll, installSkill,
  } = useMarketplaceStore();
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  useEffect(() => {
    loadRegistries();
    loadSkills();
  }, [loadRegistries, loadSkills]);

  useEffect(() => {
    const handle = setTimeout(() => loadSkills(query), 250);
    return () => clearTimeout(handle);
  }, [query, loadSkills]);

  const handleInstall = async (registryId: string, skillId: string) => {
    setError(null);
    try {
      await installSkill(registryId, skillId);
      setInstalledIds((prev) => new Set(prev).add(`${registryId}:${skillId}`));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      await refreshAll();
    } finally {
      setRefreshingAll(false);
    }
  };

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto">
        <PageHeader
          icon={<CloudIcon className="w-5 h-5" />}
          title={t("marketplace.title")}
          subtitle={t("marketplace.subtitle")}
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)} className="flex items-center gap-1.5 !text-sm w-fit">
              <AddIcon className="w-4 h-4" />
              {t("marketplace.addRegistry")}
            </Button>
          }
        />

        {/* Registries */}
        <section className="mb-8 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-white/5 bg-gray-50/60 dark:bg-white/[0.02]">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("marketplace.registries")}
              {registries.length > 0 && (
                <span className="ml-1.5 font-normal normal-case text-gray-400 dark:text-gray-500">
                  ({registries.length})
                </span>
              )}
            </span>
            {registries.length > 0 && (
              <Button variant="link" onClick={handleRefreshAll} disabled={refreshingAll} className="!text-xs flex items-center gap-1.5">
                {refreshingAll && <AnimateSpin className="w-3 h-3" />}
                {t("marketplace.refreshAll")}
              </Button>
            )}
          </div>
          {registries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
              <CloudIcon className="w-6 h-6 text-gray-300 dark:text-white/15" />
              <p className="text-sm text-gray-400 dark:text-gray-500">{t("marketplace.registries.empty")}</p>
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

        {/* Search */}
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
        </div>

        {error && (
          <p className="text-sm text-red-500 dark:text-red-400 mb-4 px-1">{error}</p>
        )}

        {/* Skills */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500 py-6 justify-center">
            <AnimateSpin className="w-4 h-4" />
            {t("marketplace.loading")}
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-gray-400 dark:text-gray-500">
            <CloudIcon className="w-8 h-8 opacity-30" />
            <p className="text-sm text-center max-w-xs">{t("marketplace.empty")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
            {skills.map((skill) => {
              const key = `${skill.registryId}:${skill.id}`;
              const installed = installedIds.has(key);
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
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
                        {skill.registryName}
                      </span>
                    </div>
                  </div>

                  {skill.description && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">{skill.description}</p>
                  )}
                  {skill.categories.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {skill.categories.map((c) => (
                        <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
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

      {addOpen && <AddRegistryDialog onClose={() => setAddOpen(false)} />}
    </main>
  );
}
