import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, EmptyState, Skeleton, Tooltip } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { CreateIssueDialog } from "./CreateIssueDialog";
import { CreatePullDialog } from "./CreatePullDialog";
import { ForgeIcon } from "./forgeMeta";
import { ItemDetailDialog } from "./ItemDetailDialog";
import { forgeIssues, forgePulls } from "./ipc";
import { SignInButton } from "./RepoAccountBar";
import { forgeErrorOf, type ForgeError, type ForgeItem, type RepoTarget } from "./types";

type Filter = "open" | "closed" | "merged" | "all";

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
        icon={<ForgeIcon kind={target.kind} className="w-7 h-7" />}
        title={t(error.kind === "auth" ? "forge.error.auth" : "forge.error.noAccount", { host: target.host })}
        description={error.kind === "auth" ? error.message : t("forge.error.noAccountDesc")}
        action={<SignInButton target={target} />}
      />
    );
  }
  return (
    <p className="px-3 py-4 text-center text-[11px] text-red-500 dark:text-red-400 break-words">{error.message}</p>
  );
}

/**
 * Los PRs o los issues del repo, con filtro de estado. Un click abre el detalle (con los
 * comentarios y lo que se puede hacer); "+" abre uno nuevo.
 */
export function ForgeItemsView({ cwd, target, what, branch }: {
  cwd: string;
  target: RepoTarget;
  what: "pulls" | "issues";
  /** La rama actual: de ahí sale un PR nuevo. */
  branch: string | null;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("open");
  const [items, setItems] = useState<ForgeItem[] | null>(null);
  const [error, setError] = useState<ForgeError | null>(null);
  const [open, setOpen] = useState<ForgeItem | null>(null);
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
    return <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">{t("forge.noApi")}</p>;
  }

  const filters: Filter[] = pr ? ["open", "merged", "closed", "all"] : ["open", "closed", "all"];

  return (
    <>
      <div className="flex items-center gap-0.5 h-8 shrink-0 px-2">
        {/* El panel mide 288px: con cuatro filtros y dos acciones no siempre entra todo.
            Los filtros ceden (se deslizan de costado); las acciones siempre se ven. */}
        <div className="flex items-center gap-0.5 flex-1 min-w-0 cc-scroll-x">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`cc-t shrink-0 h-5.5 px-1.5 rounded-md text-[10.5px]
                ${filter === f
                  ? "bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-semibold"
                  : "text-gray-500 dark:text-white/40 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
            >
              {t(`forge.filter.${f}`)}
            </button>
          ))}
        </div>
        <Tooltip content={t("forge.refresh")} placement="bottom">
          <button onClick={() => { setItems(null); load(); }} aria-label={t("forge.refresh")}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <RefreshIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t(pr ? "forge.pr.new" : "forge.issue.new")} placement="bottom">
          <button onClick={() => setCreating(true)} aria-label={t(pr ? "forge.pr.new" : "forge.issue.new")}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <AddIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll pb-2">
        {error ? (
          <ForgeErrorView error={error} target={target} />
        ) : items === null ? (
          <div className="flex flex-col gap-2 px-3.5 py-2">
            {[80, 60, 70].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">
            {t(pr ? "forge.pr.none" : "forge.issue.none")}
          </p>
        ) : items.map((item) => (
          <button
            key={item.number}
            onClick={() => setOpen(item)}
            title={item.title}
            className="flex flex-col gap-0.5 w-full px-3 py-1.5 text-left hover:bg-gray-200/50 dark:hover:bg-white/4"
          >
            <span className="flex items-baseline gap-1.5 min-w-0 w-full">
              <span className={`shrink-0 font-mono text-[10.5px] ${STATE_CLASS[item.state] ?? ""}`}>#{item.number}</span>
              <span className={`flex-1 min-w-0 truncate text-[11.5px]
                ${item.draft ? "text-gray-400 dark:text-white/40" : "text-gray-800 dark:text-gray-200"}`}>
                {item.title}
              </span>
            </span>
            <span className="flex items-center gap-1.5 min-w-0 w-full pl-0.5 text-[10px] text-gray-400 dark:text-white/30">
              {item.author && <span className="truncate">@{item.author}</span>}
              {item.sourceBranch && <span className="truncate font-mono">{item.sourceBranch}</span>}
              {item.draft && <span>{t("forge.draft")}</span>}
              <span className="flex-1" />
              {!!item.comments && <span className="shrink-0 tabular-nums">{t("forge.comments", { count: item.comments })}</span>}
              {item.updatedAt && <span className="shrink-0 tabular-nums">{elapsed(Date.parse(item.updatedAt))}</span>}
            </span>
          </button>
        ))}
      </div>

      {open && (
        <ItemDetailDialog
          cwd={cwd}
          item={open}
          pr={pr}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
      {creating && pr && (
        <CreatePullDialog cwd={cwd} branch={branch} onClose={() => setCreating(false)}
          onCreated={(item) => { setCreating(false); setFilter("open"); load(); setOpen(item); }} />
      )}
      {creating && !pr && (
        <CreateIssueDialog cwd={cwd} onClose={() => setCreating(false)}
          onCreated={(item) => { setCreating(false); setFilter("open"); load(); setOpen(item); }} />
      )}
    </>
  );
}
