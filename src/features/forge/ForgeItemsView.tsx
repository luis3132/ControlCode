import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, Badge, Button, EmptyState, Skeleton, Tooltip } from "neogestify-ui-components";

import { IssueIcon, PullRequestIcon, RefreshIcon } from "@/app/icons";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { CreateIssueDialog } from "./CreateIssueDialog";
import { CreatePullDialog } from "./CreatePullDialog";
import { ForgeIcon } from "./forgeMeta";
import { forgeIssues, forgePulls } from "./ipc";
import { SignInButton } from "./SignInButton";
import { forgeErrorOf, type ForgeError, type ForgeItem, type RepoTarget } from "./types";

export type ItemFilter = "open" | "closed" | "merged" | "all";

const STATE_CLASS: Record<string, string> = {
  open: "text-emerald-600 dark:text-emerald-400",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-500 dark:text-red-400",
};

/** Lo que se muestra cuando la API no puede contestar, con la salida que corresponde. */
export function ForgeErrorView({ error, target }: { error: ForgeError; target: RepoTarget }) {
  const { t } = useTranslation();
  if (error.kind === "noAccount" || error.kind === "auth") {
    return (
      <EmptyState
        className="m-auto px-4"
        icon={<ForgeIcon kind={target.kind} className="w-8 h-8" />}
        title={t(error.kind === "auth" ? "forge.error.auth" : "forge.error.noAccount", { host: target.host })}
        description={error.kind === "auth" ? error.message : t("forge.error.noAccountDesc")}
        action={<SignInButton target={target} />}
      />
    );
  }
  return (
    <p className="px-4 py-8 text-center text-[12px] text-red-500 dark:text-red-400 break-words">{error.message}</p>
  );
}

/**
 * Los PRs o los issues de un repo, con su filtro de estado. Un click abre su pantalla
 * (`onOpen`); "Nuevo" crea uno y lo abre.
 */
export function ForgeItemsView({ cwd, target, what, branch, filter, onFilter, onOpen }: {
  cwd: string;
  target: RepoTarget;
  what: "pulls" | "issues";
  /** La rama actual: de ahí sale un PR nuevo. */
  branch: string | null;
  filter: ItemFilter;
  onFilter: (f: ItemFilter) => void;
  onOpen: (item: ForgeItem) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ForgeItem[] | null>(null);
  const [error, setError] = useState<ForgeError | null>(null);
  const [creating, setCreating] = useState(false);
  const pr = what === "pulls";

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await (pr ? forgePulls : forgeIssues)(cwd, filter));
    } catch (e) {
      setError(forgeErrorOf(e));
      setItems([]);
    }
  }, [cwd, filter, pr]);

  useEffect(() => { setItems(null); load(); }, [load]);

  if (!target.account) {
    return <ForgeErrorView error={{ kind: "noAccount", message: target.host }} target={target} />;
  }
  if (target.kind === "other" || target.account.kind === "other") {
    return <p className="px-4 py-10 text-center text-[12px] text-gray-400 dark:text-white/30">{t("forge.noApi")}</p>;
  }

  const filters: ItemFilter[] = pr ? ["open", "merged", "closed", "all"] : ["open", "closed", "all"];
  const Icon = pr ? PullRequestIcon : IssueIcon;

  return (
    <>
      <div className="flex items-center gap-1 h-11 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => onFilter(f)}
            className={`cc-t h-7 px-2.5 rounded-lg text-[12px]
              ${filter === f
                ? "bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-semibold"
                : "text-gray-500 dark:text-white/45 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
          >
            {t(`forge.filter.${f}`)}
          </button>
        ))}
        <div className="flex-1" />
        <Tooltip content={t("forge.refresh")} placement="bottom">
          <button onClick={() => { setItems(null); load(); }} aria-label={t("forge.refresh")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <RefreshIcon className="w-4 h-4" />
          </button>
        </Tooltip>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} className="flex items-center gap-1">
          <AddIcon className="w-3.5 h-3.5" />
          {t(pr ? "forge.pr.new" : "forge.issue.new")}
        </Button>
      </div>

      <div className="flex-1 min-h-0 cc-scroll">
        {error ? (
          <ForgeErrorView error={error} target={target} />
        ) : items === null ? (
          <div className="flex flex-col gap-3 px-5 py-4">
            {[80, 60, 70, 55].map((w, i) => <Skeleton key={i} variant="text" height={14} width={`${w}%`} />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            className="m-auto pt-16"
            icon={<Icon className="w-8 h-8" />}
            title={t(pr ? "forge.pr.none" : "forge.issue.none")}
          />
        ) : items.map((item) => (
          <button
            key={item.number}
            onClick={() => onOpen(item)}
            className="flex items-start gap-3 w-full px-4 py-2.5 text-left
              border-b border-gray-100 dark:border-white/4 hover:bg-gray-100/70 dark:hover:bg-white/3"
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${STATE_CLASS[item.state] ?? ""}`} />
            <span className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span className={`text-[13px] font-medium
                  ${item.draft ? "text-gray-500 dark:text-white/45" : "text-gray-900 dark:text-gray-100"}`}>
                  {item.title}
                </span>
                {item.draft && <Badge variant="warning" size="sm">{t("forge.draft")}</Badge>}
                {item.labels.map((l) => <Badge key={l} variant="neutral" size="sm">{l}</Badge>)}
              </span>
              <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-gray-400 dark:text-white/35">
                <span className="font-mono">#{item.number}</span>
                {item.author && <span>· @{item.author}</span>}
                {item.sourceBranch && item.targetBranch && (
                  <span className="truncate font-mono">· {item.sourceBranch} → {item.targetBranch}</span>
                )}
                {item.updatedAt && <span className="shrink-0">· {t("forge.updated", { ago: elapsed(Date.parse(item.updatedAt)) })}</span>}
              </span>
            </span>
            {!!item.comments && (
              <span className="shrink-0 mt-0.5 text-[11px] tabular-nums text-gray-400 dark:text-white/35">
                {t("forge.comments", { count: item.comments })}
              </span>
            )}
          </button>
        ))}
      </div>

      {creating && pr && (
        <CreatePullDialog cwd={cwd} target={target} branch={branch} onClose={() => setCreating(false)}
          onCreated={(item) => { setCreating(false); onFilter("open"); load(); onOpen(item); }} />
      )}
      {creating && !pr && (
        <CreateIssueDialog cwd={cwd} kind={target.account?.kind ?? target.kind} onClose={() => setCreating(false)}
          onCreated={(item) => { setCreating(false); onFilter("open"); load(); onOpen(item); }} />
      )}
    </>
  );
}
