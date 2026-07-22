import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import { AddIcon, BackIcon, TrashIcon, SearchIcon, CloudIcon } from "neogestify-ui-components";
import { useMarketplaceStore } from "../store/marketplace";
import { AddRegistryDialog } from "../components/marketplace/AddRegistryDialog";

function timeAgo(ts: number | null): string {
  if (ts == null) return "";
  const diffS = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h`;
  return `${Math.floor(diffS / 86400)}d`;
}

export function MarketplacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    registries, skills, loading, refreshingId, installingKey,
    loadRegistries, loadSkills, removeRegistry, setRegistryEnabled, refreshRegistry, refreshAll, installSkill,
  } = useMarketplaceStore();
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <Button variant="icon" onClick={() => navigate("/")} title={t("btn.back")}>
              <BackIcon className="w-4 h-4" />
            </Button>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {t("marketplace.title")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("marketplace.subtitle")}
              </p>
            </div>
          </div>
          <Button variant="primary" onClick={() => setAddOpen(true)} className="flex items-center gap-1.5 !text-sm w-fit">
            <AddIcon className="w-4 h-4" />
            {t("marketplace.addRegistry")}
          </Button>
        </div>

        {/* Registries */}
        <div className="mb-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-white/5">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {t("marketplace.registries")}
            </span>
            <Button variant="link" onClick={refreshAll} className="!text-xs">
              {t("marketplace.refreshAll")}
            </Button>
          </div>
          {registries.length === 0 ? (
            <p className="px-4 py-3 text-sm italic text-gray-400 dark:text-gray-500">
              {t("marketplace.registries.empty")}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-white/5">
              {registries.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => setRegistryEnabled(r.id, e.target.checked)}
                      className="shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{r.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 shrink-0">
                          {r.sourceType}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400 dark:text-gray-500 truncate block font-mono">
                        {r.location}
                      </span>
                      {r.error ? (
                        <span className="text-xs text-red-500 dark:text-red-400 truncate block">{r.error}</span>
                      ) : r.lastFetched != null && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {t("marketplace.registries.skillCount", { count: r.skillCount })} · {t("marketplace.registries.fetchedAgo", { time: timeAgo(r.lastFetched) })}
                        </span>
                      )}
                    </div>
                  </label>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      onClick={() => refreshRegistry(r.id)}
                      disabled={refreshingId === r.id}
                      className="!text-xs"
                    >
                      {refreshingId === r.id ? t("marketplace.registries.refreshing") : t("marketplace.registries.refresh")}
                    </Button>
                    <Button variant="danger" onClick={() => removeRegistry(r.id)} title={t("btn.cancel")}>
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Search */}
        <div className="mb-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("marketplace.searchPlaceholder")}
            variant="outline"
            icon={<SearchIcon className="w-4 h-4" />}
          />
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400 mb-4">{error}</p>}

        {/* Skills */}
        {loading ? (
          <p className="text-sm italic text-gray-400 dark:text-gray-500">{t("marketplace.loading")}</p>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-gray-400 dark:text-gray-500">
            <CloudIcon className="w-8 h-8 opacity-40" />
            <p className="text-sm">{t("marketplace.empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((skill) => {
              const key = `${skill.registryId}:${skill.id}`;
              const installed = installedIds.has(key);
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border
                    border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50
                    hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {skill.name}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 shrink-0">
                        {skill.registryName}
                      </span>
                    </div>
                    {skill.description && (
                      <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{skill.description}</p>
                    )}
                    {skill.categories.length > 0 && (
                      <span className="flex flex-wrap gap-1 mt-1">
                        {skill.categories.map((c) => (
                          <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                            {c}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <Button
                    variant={installed ? "outline" : "primary"}
                    disabled={installed || installingKey === key}
                    onClick={() => handleInstall(skill.registryId, skill.id)}
                    className="!text-xs shrink-0"
                  >
                    {installed
                      ? t("marketplace.installed")
                      : installingKey === key
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
