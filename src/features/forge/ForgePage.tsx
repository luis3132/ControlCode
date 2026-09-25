import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, Skeleton } from "neogestify-ui-components";

import { IssueIcon, PullRequestIcon } from "@/app/icons";
import { useShellGroups } from "@/app/shellContext";
import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup, WorkspaceNode } from "@/features/workspaces/workspaceTree";

import { ForgeItemsView, type ItemFilter } from "./ForgeItemsView";
import { ForgeIcon } from "./forgeMeta";
import { forgeSetRepoAccount } from "./ipc";
import { ItemDetailView } from "./ItemDetailView";
import type { ForgeItem } from "./types";
import { useRepoTarget } from "./useRepoTarget";

type Section = "pulls" | "issues";

/** Un repo con workspaces abiertos, y la carpeta desde la que se le habla. */
interface OpenRepo {
  key: string;
  name: string;
  /** El checkout principal si está abierto; si no, el primer worktree abierto. */
  main: WorkspaceNode;
  open: WorkspaceNode[];
}

function openRepos(groups: RepoGroup[]): OpenRepo[] {
  return groups
    .filter((g) => g.isRepo)
    .map((g) => {
      const open = g.workspaces.filter((w) => !w.closed);
      const main = open.find((w) => w.isPrimary) ?? open[0];
      return main ? { key: g.key, name: g.name, main, open } : null;
    })
    .filter((r): r is OpenRepo => r !== null);
}

/** Una fila de la columna de repos: nombre, host y cuenta, y las ramas abiertas. */
function RepoRow({ repo, active, onClick }: { repo: OpenRepo; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const { target } = useRepoTarget(repo.main.cwd);
  const branches = [...new Set(repo.open.map((w) => w.branch).filter(Boolean))] as string[];

  return (
    <button
      onClick={onClick}
      className={`cc-t flex items-start gap-2.5 w-full px-2.5 py-2 rounded-lg text-left
        ${active
          ? "bg-blue-500/12 dark:bg-blue-400/13"
          : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}
    >
      <ForgeIcon kind={target?.kind ?? null} className="w-4 h-4 mt-0.5 shrink-0 text-gray-500 dark:text-white/45" />
      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className={`truncate text-[12.5px] ${active ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-200"}`}>
          {repo.name}
        </span>
        <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
          {target === undefined
            ? "…"
            : target === null
              ? t("forge.page.noRemote")
              : target.account
                ? `${target.host} · @${target.account.login}`
                : t("forge.page.noAccount", { host: target.host })}
        </span>
        {branches.length > 0 && (
          <span className="truncate font-mono text-[10px] text-gray-400 dark:text-white/30">{branches.join(" · ")}</span>
        )}
      </span>
    </button>
  );
}

/**
 * Pull requests e issues de los repos abiertos, en su propia pantalla.
 *
 * A la izquierda los repos de los workspaces abiertos (varios worktrees del mismo repo son
 * un solo repo: los PRs son del repo, no de la carpeta). A la derecha, del elegido, sus
 * PRs y sus issues, cada uno con su filtro de estado; abrir uno lo muestra entero en la
 * misma pantalla.
 */
export function ForgePage() {
  const { t } = useTranslation();
  const groups = useShellGroups();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const repos = useMemo(() => openRepos(groups), [groups]);
  const looseFolders = useMemo(
    () => groups.filter((g) => !g.isRepo && g.workspaces.some((w) => !w.closed)).length,
    [groups]
  );

  // Arranca en el repo de la tab activa: es casi siempre del que se quiere ver los PRs.
  const activeCwd = tabs.find((tab) => tab.id === activeTabId)?.cwd ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected && repos.some((r) => r.key === selected)) return;
    const fromActive = repos.find((r) => r.open.some((w) => w.cwd === activeCwd));
    setSelected((fromActive ?? repos[0])?.key ?? null);
  }, [repos, selected, activeCwd]);

  const repo = repos.find((r) => r.key === selected) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-[54px] shrink-0 pl-4 pr-14 border-b border-gray-200 dark:border-white/8">
        <PullRequestIcon className="w-[15px] h-[15px] shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">{t("forge.page.title")}</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ══ los repos abiertos ═══════════════════════════════════════ */}
        <nav className="flex flex-col w-64 shrink-0 min-h-0 border-r border-gray-200 dark:border-white/8
          bg-gray-100/50 dark:bg-black/20">
          <span className="shrink-0 px-4 pt-3 pb-1.5 text-[9.5px] font-extrabold uppercase tracking-[0.11em]
            text-gray-400 dark:text-white/30">
            {t("forge.page.openRepos")}
          </span>
          <div className="flex-1 min-h-0 cc-scroll flex flex-col gap-0.5 px-1.5 pb-2">
            {repos.length === 0 ? (
              <p className="px-2.5 py-2 text-[11.5px] leading-relaxed text-gray-400 dark:text-white/35">
                {t("forge.page.none")}
              </p>
            ) : repos.map((r) => (
              <RepoRow key={r.key} repo={r} active={r.key === selected} onClick={() => setSelected(r.key)} />
            ))}
          </div>
          {looseFolders > 0 && (
            <p className="shrink-0 px-4 py-2 text-[10px] leading-relaxed border-t border-gray-200 dark:border-white/8
              text-gray-400 dark:text-white/30">
              {t("forge.page.loose", { count: looseFolders })}
            </p>
          )}
        </nav>

        {/* ══ PRs e issues del elegido ═════════════════════════════════ */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {repo ? (
            <RepoPane key={repo.key} repo={repo} />
          ) : (
            <EmptyState
              className="m-auto"
              icon={<PullRequestIcon className="w-8 h-8" />}
              title={t("forge.page.pick")}
              description={t("forge.page.pickDesc")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Un repo: su cuenta, y sus dos secciones, cada una con su filtro y su pantalla abierta. */
function RepoPane({ repo }: { repo: OpenRepo }) {
  const { t } = useTranslation();
  const cwd = repo.main.cwd;
  const { target, reload } = useRepoTarget(cwd);
  const [section, setSection] = useState<Section>("pulls");
  const [filters, setFilters] = useState<Record<Section, ItemFilter>>({ pulls: "open", issues: "open" });
  const [opened, setOpened] = useState<Record<Section, ForgeItem | null>>({ pulls: null, issues: null });
  // Cambia cuando algo se modificó adentro de un PR o issue (comentario, fusión): la lista
  // se vuelve a montar y se relee al volver.
  const [version, setVersion] = useState(0);

  if (target === undefined) {
    return (
      <div className="flex flex-col gap-3 p-5">
        {[50, 70, 40].map((w, i) => <Skeleton key={i} variant="text" height={14} width={`${w}%`} />)}
      </div>
    );
  }
  if (target === null) {
    return <EmptyState className="m-auto" icon={<PullRequestIcon className="w-8 h-8" />} title={t("forge.page.noRemote")} />;
  }

  const item = opened[section];

  return (
    <>
      {/* ── encabezado: repo, cuenta, secciones ─────────────────────── */}
      <div className="flex items-center gap-3 h-12 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
        <ForgeIcon kind={target.kind} className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/45" />
        <span className="min-w-0 truncate text-[13px] font-semibold text-gray-900 dark:text-white" title={target.remoteUrl}>
          {target.path}
        </span>
        <div className="flex items-center gap-0.5 ml-2">
          {(["pulls", "issues"] as Section[]).map((s) => {
            const Icon = s === "pulls" ? PullRequestIcon : IssueIcon;
            return (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`cc-t flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px]
                  ${section === s
                    ? "bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-semibold"
                    : "text-gray-500 dark:text-white/45 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t(`forge.page.${s}`)}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        {target.account && target.accounts.length > 1 ? (
          <select
            value={target.account.id}
            onChange={async (e) => {
              await forgeSetRepoAccount(target.root, e.target.value).catch(console.error);
              setOpened({ pulls: null, issues: null });
              reload();
            }}
            title={t("forge.pickAccount")}
            className="h-7 px-2 rounded-lg text-[12px] outline-none bg-transparent
              text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/10"
          >
            {target.accounts.map((a) => <option key={a.id} value={a.id}>@{a.login}</option>)}
          </select>
        ) : target.account ? (
          <span className="text-[12px] text-gray-500 dark:text-white/45">@{target.account.login}</span>
        ) : (
          // El botón para iniciar sesión ya está en el centro, donde irían las listas.
          <span className="text-[12px] text-gray-400 dark:text-white/35">{t("forge.page.noAccount", { host: target.host })}</span>
        )}
      </div>

      {item ? (
        <ItemDetailView
          key={`${section}-${item.number}`}
          cwd={cwd}
          item={item}
          pr={section === "pulls"}
          onBack={() => setOpened((o) => ({ ...o, [section]: null }))}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ) : (
        <ForgeItemsView
          key={`${section}-${version}-${target.account?.id ?? "none"}`}
          cwd={cwd}
          target={target}
          what={section}
          branch={repo.main.branch}
          filter={filters[section]}
          onFilter={(f) => setFilters((prev) => ({ ...prev, [section]: f }))}
          onOpen={(it) => setOpened((o) => ({ ...o, [section]: it }))}
        />
      )}
    </>
  );
}
