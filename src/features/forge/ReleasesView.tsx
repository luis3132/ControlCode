import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AddIcon, ArrowLeftIcon, Badge, Button, EmptyState, Skeleton, Tooltip } from "neogestify-ui-components";

import { ExternalIcon, RefreshIcon, TagIcon } from "@/app/icons";
import { Markdown } from "@/shared/ui/Markdown";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { CreateReleaseDialog } from "./CreateReleaseDialog";
import { ForgeErrorView } from "./ForgeItemsView";
import { forgeReleases } from "./ipc";
import { forgeErrorOf, type ForgeError, type Release, type RepoTarget } from "./types";

function ReleaseBadges({ r }: { r: Release }) {
  const { t } = useTranslation();
  return (
    <>
      {r.draft && <Badge variant="warning" size="sm">{t("forge.release.draftBadge")}</Badge>}
      {r.prerelease && <Badge variant="accent" size="sm">{t("forge.release.prereleaseBadge")}</Badge>}
    </>
  );
}

/** Las releases del repo; abrir una muestra sus notas en la misma pantalla. */
export function ReleasesView({ cwd, target }: { cwd: string; target: RepoTarget }) {
  const { t } = useTranslation();
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<ForgeError | null>(null);
  const [open, setOpen] = useState<Release | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReleases(await forgeReleases(cwd));
    } catch (e) {
      setError(forgeErrorOf(e));
      setReleases([]);
    }
  }, [cwd]);

  useEffect(() => { setReleases(null); load(); }, [load]);

  if (!target.account) {
    return <ForgeErrorView error={{ kind: "noAccount", message: target.host }} target={target} />;
  }

  if (open) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-2 h-11 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
          <button onClick={() => setOpen(null)}
            className="cc-t flex items-center gap-1.5 h-7 px-2 -ml-2 rounded-md text-[12px] text-gray-500 dark:text-white/50
              hover:text-gray-900 dark:hover:text-white hover:bg-gray-200/60 dark:hover:bg-white/6">
            <ArrowLeftIcon className="w-3.5 h-3.5" />
            {t("forge.page.releases")}
          </button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => openUrl(open.webUrl).catch(console.error)} className="flex items-center gap-1.5">
            <ExternalIcon className="w-3 h-3" />
            {t("forge.openWeb")}
          </Button>
        </div>
        <div className="flex-1 min-h-0 cc-scroll">
          <div className="flex flex-col gap-3 max-w-3xl mx-auto px-6 py-5">
            <h2 className="text-[18px] font-semibold text-gray-900 dark:text-white">{open.name || open.tag}</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-gray-500 dark:text-white/45">
              <span className="flex items-center gap-1 font-mono"><TagIcon className="w-3 h-3" />{open.tag}</span>
              <ReleaseBadges r={open} />
              {open.author && <span>· @{open.author}</span>}
              {open.createdAt && <span>· {new Date(open.createdAt).toLocaleString()}</span>}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-white/8 px-4 py-3 text-[13px]">
              {open.body ? <Markdown content={open.body} /> : (
                <p className="text-gray-400 dark:text-white/35 italic">{t("forge.noDescription")}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1 h-11 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
        <span className="text-[12px] text-gray-500 dark:text-white/45">{t("forge.release.hint")}</span>
        <div className="flex-1" />
        <Tooltip content={t("forge.refresh")} placement="bottom">
          <button onClick={() => { setReleases(null); load(); }} aria-label={t("forge.refresh")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <RefreshIcon className="w-4 h-4" />
          </button>
        </Tooltip>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} className="flex items-center gap-1">
          <AddIcon className="w-3.5 h-3.5" />
          {t("forge.release.new")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 cc-scroll">
        {error ? (
          <ForgeErrorView error={error} target={target} />
        ) : releases === null ? (
          <div className="flex flex-col gap-3 px-5 py-4">
            {[70, 55, 65].map((w, i) => <Skeleton key={i} variant="text" height={14} width={`${w}%`} />)}
          </div>
        ) : releases.length === 0 ? (
          <EmptyState className="m-auto pt-16" icon={<TagIcon className="w-8 h-8" />} title={t("forge.release.none")} />
        ) : releases.map((r) => (
          <button key={r.tag} onClick={() => setOpen(r)}
            className="flex items-start gap-3 w-full px-4 py-2.5 text-left border-b border-gray-100 dark:border-white/4
              hover:bg-gray-100/70 dark:hover:bg-white/3">
            <TagIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100">{r.name || r.tag}</span>
                <ReleaseBadges r={r} />
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-white/35">
                <span className="font-mono">{r.tag}</span>
                {r.author && <span>· @{r.author}</span>}
                {r.createdAt && <span>· {t("forge.updated", { ago: elapsed(Date.parse(r.createdAt)) })}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
      {creating && (
        <CreateReleaseDialog
          cwd={cwd}
          root={target.root}
          kind={target.account.kind}
          onClose={() => setCreating(false)}
          onCreated={(r) => { setCreating(false); load(); setOpen(r); }}
        />
      )}
    </>
  );
}
