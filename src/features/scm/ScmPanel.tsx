import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AddIcon, Alert, Button, ChevronDownIcon, ChevronRightIcon, CloudIcon, DocumentIcon, EmptyState, MinusIcon,
  Skeleton, Tooltip,
} from "neogestify-ui-components";

import { BranchIcon, ExternalIcon, GithubIcon, GitlabIcon, PullIcon, PushIcon, UndoIcon } from "@/app/icons";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { elapsed, invalidateRepoInfo } from "@/features/workspaces/useRepoInfo";

import { BranchMenu } from "./BranchMenu";
import {
  scmCheckout, scmCommit, scmDiscard, scmFetch, scmInit, scmLog, scmPull, scmPush, scmStage, scmStatus, scmUnstage,
} from "./ipc";
import { isScmError, type Commit, type Provider, type ScmEntry, type ScmError, type ScmStatus } from "./types";

/** Cada cuánto se vuelve a leer el estado mientras el panel está a la vista. Los agentes
 *  escriben archivos todo el tiempo; sin esto la lista quedaría vieja enseguida. */
const POLL_MS = 4000;

const STATUS_CLASS: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  R: "text-emerald-600 dark:text-emerald-400",
  C: "text-emerald-600 dark:text-emerald-400",
  D: "text-red-500 dark:text-red-400",
  U: "text-red-500 dark:text-red-400",
  T: "text-amber-600 dark:text-amber-400",
  "?": "text-emerald-600 dark:text-emerald-400",
};

function ProviderIcon({ provider, className }: { provider: Provider; className: string }) {
  if (provider === "github") return <GithubIcon className={className} />;
  if (provider === "gitlab") return <GitlabIcon className={className} />;
  return <CloudIcon className={className} />;
}

function IconAction({ label, onClick, children, disabled, danger }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={disabled}
        aria-label={label}
        className={`cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
          text-gray-400 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10
          disabled:opacity-40 disabled:hover:bg-transparent
          ${danger ? "hover:text-red-500 dark:hover:text-red-400" : "hover:text-gray-800 dark:hover:text-white"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

type Group = "conflicted" | "staged" | "changes";

/**
 * Control de versiones del workspace activo, al estilo del de VS Code.
 *
 * Preparar, descartar y commitear; cambiar o crear ramas; traer y subir. Todo corre con
 * el `git` del usuario, con sus hooks y sus credenciales — el panel no guarda ningún
 * secreto. Cuando a git le faltan credenciales se dice cuáles, en vez de un error crudo:
 * es el lugar donde después va a entrar el login con el proveedor.
 *
 * Un click en un archivo abre su diff como tab.
 */
export function ScmPanel({ cwd }: { cwd: string | null }) {
  const { t } = useTranslation();
  const openDiff = useViewTabsStore((s) => s.openDiff);
  const openFile = useViewTabsStore((s) => s.openFile);
  const [status, setStatus] = useState<ScmStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ScmError | null>(null);
  const [message, setMessage] = useState("");
  const [branchMenu, setBranchMenu] = useState(false);
  const [closedGroups, setClosedGroups] = useState<Set<Group>>(new Set());
  const [log, setLog] = useState<Commit[] | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [discard, setDiscard] = useState<{ tracked: string[]; untracked: string[]; label: string } | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /** Cuántos cambios había en la lectura anterior: si cambia, las demás vistas del repo
   *  (el número sobre el icono, las marcas del árbol) también tienen que enterarse. */
  const lastCount = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    try {
      const next = await scmStatus(cwd);
      setStatus(next);
      if (next) {
        const count = next.staged.length + next.unstaged.length + next.untracked.length + next.conflicted.length;
        if (lastCount.current !== null && lastCount.current !== count) invalidateRepoInfo(next.root);
        lastCount.current = count;
      }
    } catch (e) {
      setError(isScmError(e) ? e : { kind: "git", message: String(e) });
    }
  }, [cwd]);

  // Cambiar de workspace es otro repo: lo del anterior no puede verse ni un instante.
  useEffect(() => {
    setStatus(undefined);
    setError(null);
    setLog(null);
    lastCount.current = null;
    setBranchMenu(false);
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => {
      // Mientras corre una operación, el estado va a cambiar al terminar: leerlo a mitad
      // mostraría un estado intermedio que parpadea.
      if (document.visibilityState === "visible" && !busyRef.current) load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const root = status?.root ?? null;

  const loadLog = useCallback(() => {
    if (root) scmLog(root, 30).then(setLog).catch(() => setLog([]));
  }, [root]);

  useEffect(() => { if (logOpen) loadLog(); }, [logOpen, loadLog]);

  /** Corre una operación: bloquea el resto, refresca todo al terminar y avisa a las demás
   *  vistas del repo (marcas del árbol, rama del lateral). */
  const run = async (name: string, op: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(isScmError(e) ? e : { kind: "git", message: String(e) });
    } finally {
      await load();
      if (root) invalidateRepoInfo(root);
      if (logOpen) loadLog();
      setBusy(null);
    }
  };

  const changes = useMemo(
    () => (status ? [...status.unstaged, ...status.untracked].sort((a, b) => a.path.localeCompare(b.path)) : []),
    [status]
  );

  if (!cwd) {
    return <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">{t("explorer.noTab")}</p>;
  }
  if (status === undefined) {
    return (
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {[70, 50, 80, 45].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
      </div>
    );
  }
  if (status === null) {
    return (
      <EmptyState
        className="m-auto px-4"
        icon={<BranchIcon className="w-7 h-7" />}
        title={t("scm.notRepo")}
        description={t("scm.notRepo.desc")}
        action={
          <Button size="sm" variant="primary" disabled={busy !== null}
            onClick={() => run("init", () => scmInit(cwd))}>
            {t("scm.init")}
          </Button>
        }
      />
    );
  }

  const stagedCount = status.staged.length;
  const totalChanges = stagedCount + changes.length + status.conflicted.length;
  const canCommit = message.trim().length > 0 && totalChanges > 0 && status.conflicted.length === 0 && !busy;
  const remote = status.remotes.find((r) => r.name === "origin") ?? status.remotes[0] ?? null;

  const commit = () => {
    if (!canCommit) return;
    run("commit", async () => {
      // Sin nada preparado se commitea todo: es lo que se quiso decir al escribir el
      // mensaje y apretar el botón, y el botón lo avisa antes.
      await scmCommit(status.root, message, stagedCount === 0);
      setMessage("");
    });
  };

  const openEntry = (entry: ScmEntry, group: Group) => {
    const abs = `${status.root}/${entry.path}`;
    // Un archivo nuevo no tiene contra qué compararse, y uno en conflicto se resuelve
    // editándolo: los dos se abren directo.
    if (entry.status === "?" || group === "conflicted") openFile(cwd, abs);
    else openDiff(cwd, status.root, entry.path, group === "staged");
  };

  const toggleGroup = (g: Group) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const renderRow = (entry: ScmEntry, group: Group) => {
    const slash = entry.path.lastIndexOf("/");
    const name = entry.path.slice(slash + 1);
    const dir = slash > 0 ? entry.path.slice(0, slash) : "";
    const untracked = entry.status === "?";
    return (
      <div
        key={`${group}:${entry.path}`}
        onClick={() => openEntry(entry, group)}
        title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
        className="group flex items-center gap-1.5 h-[24px] pl-6 pr-2 cursor-pointer
          hover:bg-gray-200/50 dark:hover:bg-white/4"
      >
        <DocumentIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />
        <span className={`shrink-0 max-w-[55%] truncate text-[11.5px]
          ${entry.status === "D" ? "line-through text-gray-400 dark:text-white/35" : "text-gray-700 dark:text-gray-300"}`}>
          {name}
        </span>
        <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/30" dir="rtl">{dir}</span>
        <span className="hidden group-hover:flex items-center gap-0.5">
          {entry.status !== "D" && (
            <IconAction label={t("scm.openFile")} onClick={() => openFile(cwd, `${status.root}/${entry.path}`)}>
              <DocumentIcon className="w-3 h-3" />
            </IconAction>
          )}
          {group === "changes" && (
            <IconAction label={t("scm.discard")} danger disabled={!!busy}
              onClick={() => setDiscard({
                tracked: untracked ? [] : [entry.path],
                untracked: untracked ? [entry.path] : [],
                label: entry.path,
              })}>
              <UndoIcon className="w-3 h-3" />
            </IconAction>
          )}
          {group === "staged" ? (
            <IconAction label={t("scm.unstage")} disabled={!!busy}
              onClick={() => run("unstage", () => scmUnstage(status.root, [entry.path]))}>
              <MinusIcon className="w-3 h-3" />
            </IconAction>
          ) : (
            <IconAction label={t("scm.stage")} disabled={!!busy}
              onClick={() => run("stage", () => scmStage(status.root, [entry.path]))}>
              <AddIcon className="w-3 h-3" />
            </IconAction>
          )}
        </span>
        <span className={`shrink-0 w-3 font-mono text-[10px] text-center ${STATUS_CLASS[entry.status] ?? ""}`}>
          {untracked ? "U" : entry.status}
        </span>
      </div>
    );
  };

  const renderGroup = (group: Group, label: string, entries: ScmEntry[], actions: React.ReactNode) => {
    if (entries.length === 0) return null;
    const open = !closedGroups.has(group);
    return (
      <div>
        <div
          onClick={() => toggleGroup(group)}
          className="group flex items-center gap-1 h-[24px] pl-1.5 pr-2 cursor-pointer select-none
            hover:bg-gray-200/50 dark:hover:bg-white/4"
        >
          <span className="w-3.5 shrink-0 text-gray-400 dark:text-white/30">
            {open ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
          </span>
          <span className="flex-1 min-w-0 truncate text-[10px] font-extrabold uppercase tracking-[0.09em]
            text-gray-500 dark:text-white/40">
            {label}
          </span>
          <span className="hidden group-hover:flex items-center gap-0.5">{actions}</span>
          <span className="shrink-0 px-1.5 rounded-full text-[9.5px] tabular-nums
            bg-gray-200 text-gray-600 dark:bg-white/8 dark:text-gray-400">
            {entries.length}
          </span>
        </div>
        {open && entries.map((e) => renderRow(e, group))}
      </div>
    );
  };

  return (
    <>
      <div className="relative flex items-center gap-1 h-8 shrink-0 pl-2 pr-1.5 bg-gray-100/60 dark:bg-white/2">
        <button
          onClick={() => setBranchMenu((v) => !v)}
          disabled={!!busy}
          title={t("scm.branch.switch")}
          className="cc-t flex items-center gap-1.5 min-w-0 h-6 px-1.5 rounded-md
            hover:bg-gray-200 dark:hover:bg-white/8 disabled:opacity-60"
        >
          <BranchIcon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/45" />
          <span className="truncate font-mono text-[11.5px] font-semibold text-gray-800 dark:text-gray-200">
            {status.branch ?? (status.head ? t("scm.detached", { head: status.head }) : t("scm.noCommits"))}
          </span>
          <ChevronDownIcon className="w-2.5 h-2.5 shrink-0 text-gray-400" />
        </button>
        <div className="flex-1" />
        <IconAction label={t("scm.fetch")} disabled={!!busy || status.remotes.length === 0}
          onClick={() => run("fetch", () => scmFetch(status.root))}>
          <CloudIcon className="w-3.5 h-3.5" />
        </IconAction>
        <Tooltip content={t("scm.pull")} placement="bottom">
          <button
            onClick={() => run("pull", () => scmPull(status.root))}
            disabled={!!busy || !status.upstream}
            aria-label={t("scm.pull")}
            className="cc-t flex items-center gap-0.5 h-5.5 px-1 rounded-md shrink-0
              text-gray-400 dark:text-white/40 hover:text-gray-800 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PullIcon className="w-3.5 h-3.5" />
            {status.behind > 0 && <span className="text-[10px] tabular-nums">{status.behind}</span>}
          </button>
        </Tooltip>
        <Tooltip content={status.upstream ? t("scm.push") : t("scm.publish")} placement="bottom">
          <button
            onClick={() => run("push", () => scmPush(status.root))}
            disabled={!!busy || !status.branch || status.remotes.length === 0}
            aria-label={status.upstream ? t("scm.push") : t("scm.publish")}
            className={`cc-t flex items-center gap-0.5 h-5.5 px-1 rounded-md shrink-0
              hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent
              ${status.ahead > 0 || (!status.upstream && status.branch)
                ? "text-blue-600 dark:text-blue-400"
                : "text-gray-400 dark:text-white/40 hover:text-gray-800 dark:hover:text-white"}`}
          >
            <PushIcon className="w-3.5 h-3.5" />
            {status.ahead > 0 && <span className="text-[10px] tabular-nums">{status.ahead}</span>}
          </button>
        </Tooltip>

        {branchMenu && (
          <BranchMenu
            root={status.root}
            onClose={() => setBranchMenu(false)}
            onPick={(name, create, remote) => {
              setBranchMenu(false);
              run("checkout", () => scmCheckout(status.root, name, create, remote));
            }}
          />
        )}
      </div>

      {busy && (
        <div className="h-0.5 shrink-0 overflow-hidden bg-blue-500/15">
          <div className="h-full w-1/3 bg-blue-500 animate-[cc-indeterminate_1.1s_ease-in-out_infinite]" />
        </div>
      )}

      <div className="flex-1 min-h-0 cc-scroll">
        {status.operation && (
          <div className="mx-2.5 mt-2.5 px-2.5 py-2 rounded-lg text-[11px] leading-relaxed
            bg-amber-50 text-amber-800 border border-amber-200
            dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25">
            {t(`scm.operation.${status.operation}`)}
          </div>
        )}

        {error && (
          <div className="mx-2.5 mt-2.5">
            <Alert variant={error.kind === "auth" ? "warning" : "danger"}>
              <span className="block text-[11.5px]">
                {error.kind === "auth"
                  ? t("scm.error.auth", { host: remote?.host ?? t("scm.error.remote") })
                  : t("scm.error.git")}
              </span>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] opacity-80">
                {error.message}
              </pre>
            </Alert>
          </div>
        )}

        <div className="flex flex-col gap-1.5 px-2.5 pt-2.5 pb-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
              }
            }}
            rows={message.includes("\n") ? 4 : 2}
            placeholder={t("scm.message", { branch: status.branch ?? "HEAD" })}
            spellCheck={false}
            className="w-full resize-none px-2.5 py-1.5 rounded-lg outline-none text-[12px] leading-relaxed
              bg-white dark:bg-white/4 border border-gray-200 dark:border-white/10
              focus:border-blue-500 dark:focus:border-blue-400
              text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
          <Button size="sm" variant="primary" fullWidth disabled={!canCommit} onClick={commit}>
            {busy === "commit"
              ? t("scm.committing")
              : stagedCount === 0 && totalChanges > 0 ? t("scm.commitAll") : t("scm.commit")}
          </Button>
        </div>

        {totalChanges === 0 ? (
          <p className="px-3 py-4 text-center text-[11.5px] text-gray-400 dark:text-white/30">
            {t("explorer.noChanges")}
          </p>
        ) : (
          <div className="pb-2">
            {renderGroup("conflicted", t("scm.group.conflicts"), status.conflicted, null)}
            {renderGroup("staged", t("scm.group.staged"), status.staged, (
              <IconAction label={t("scm.unstageAll")} disabled={!!busy}
                onClick={() => run("unstage", () => scmUnstage(status.root, []))}>
                <MinusIcon className="w-3 h-3" />
              </IconAction>
            ))}
            {renderGroup("changes", t("scm.group.changes"), changes, (
              <>
                <IconAction label={t("scm.discardAll")} danger disabled={!!busy}
                  onClick={() => setDiscard({
                    tracked: status.unstaged.map((e) => e.path),
                    untracked: status.untracked.map((e) => e.path),
                    label: t("scm.discardAll.label", { count: changes.length }),
                  })}>
                  <UndoIcon className="w-3 h-3" />
                </IconAction>
                <IconAction label={t("scm.stageAll")} disabled={!!busy}
                  onClick={() => run("stage", () => scmStage(status.root, []))}>
                  <AddIcon className="w-3 h-3" />
                </IconAction>
              </>
            ))}
            {status.truncated && (
              <p className="px-3 py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("scm.truncated")}</p>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-gray-200 dark:border-white/7">
        <button
          onClick={() => setLogOpen((v) => !v)}
          className="flex items-center gap-1 w-full h-7 pl-1.5 pr-2 text-left hover:bg-gray-200/50 dark:hover:bg-white/4"
        >
          <span className="w-3.5 shrink-0 text-gray-400 dark:text-white/30">
            {logOpen ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
          </span>
          <span className="flex-1 text-[10px] font-extrabold uppercase tracking-[0.09em] text-gray-500 dark:text-white/40">
            {t("scm.log")}
          </span>
        </button>
        {logOpen && (
          <div className="max-h-48 cc-scroll pb-1">
            {log === null ? (
              <p className="px-3 py-2 text-[11px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
            ) : log.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-gray-400 dark:text-white/30">{t("scm.noCommits")}</p>
            ) : log.map((c) => (
              <div key={c.hash} title={`${c.hash}\n${c.author}`} className="flex items-center gap-2 h-[22px] px-3">
                <span className="shrink-0 font-mono text-[10px] text-blue-600/80 dark:text-blue-400/80">{c.short}</span>
                <span className="flex-1 min-w-0 truncate text-[11px] text-gray-700 dark:text-gray-300">{c.subject}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">
                  {elapsed(c.time * 1000)}
                </span>
              </div>
            ))}
          </div>
        )}

        {remote && (
          <div className="flex items-center gap-2 h-7 px-3 border-t border-gray-200 dark:border-white/7">
            <ProviderIcon provider={remote.provider} className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/45" />
            <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-500 dark:text-white/40" title={remote.url}>
              {remote.name} · {remote.host ?? remote.url}
            </span>
            {remote.webUrl && (
              <IconAction label={t("scm.openWeb")} onClick={() => openUrl(remote.webUrl!).catch(console.error)}>
                <ExternalIcon className="w-3 h-3" />
              </IconAction>
            )}
          </div>
        )}
      </div>

      {discard && (
        <AppDialog
          title={t("scm.discard.title")}
          size="sm"
          onClose={() => setDiscard(null)}
          closeOnEsc
          footer={
            <>
              <Button variant="outline" onClick={() => setDiscard(null)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={() => {
                const target = discard;
                setDiscard(null);
                run("discard", () => scmDiscard(status.root, target.tracked, target.untracked));
              }}>
                {t("scm.discard")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t(discard.untracked.length > 0 ? "scm.discard.bodyUntracked" : "scm.discard.body")}
          </p>
          <code className="block mt-2 text-[11px] font-mono break-all text-gray-500 dark:text-gray-400">{discard.label}</code>
        </AppDialog>
      )}
    </>
  );
}
