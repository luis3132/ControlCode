import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, Switch } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { BranchIcon, PullRequestIcon } from "@/app/icons";
import { elapsed } from "@/features/workspaces/useRepoInfo";
import { scmBranches, scmCompare, scmPush } from "@/features/scm/ipc";
import { isScmError, type Compare } from "@/features/scm/types";

import { BranchPicker, compareRef, hostBranches, MarkdownField, titleFromBranch, type HostBranch } from "./composer";
import { forgeCreatePull, forgeDefaultBranch } from "./ipc";
import { forgeErrorOf, type ForgeItem, type RepoTarget } from "./types";

/** Cuántos commits se listan en el cuerpo propuesto antes de cortar. */
const BODY_COMMITS = 20;

/**
 * Abrir un PR.
 *
 * Las ramas se eligen de las que tiene el repo (locales y del remoto), y antes de crear se
 * ve qué entraría: los commits, el tamaño del cambio y si la rama quedó atrás de la base.
 * El título y la descripción se proponen desde esos commits hasta que se los edita.
 *
 * Sube la rama antes (con la cuenta de la app): el host no deja abrir un PR de una rama
 * que no tiene, y "primero hacé push" es un paso que nadie quiere tener que recordar.
 */
export function CreatePullDialog({ cwd, target, branch, onClose, onCreated }: {
  cwd: string;
  target: RepoTarget;
  branch: string | null;
  onClose: () => void;
  onCreated: (item: ForgeItem) => void;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<HostBranch[] | null>(null);
  const [head, setHead] = useState(branch ?? "");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [body, setBody] = useState("");
  const [bodyEdited, setBodyEdited] = useState(false);
  const [draft, setDraft] = useState(false);
  const [push, setPush] = useState(true);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [compareError, setCompareError] = useState("");
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState<"push" | "create" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    scmBranches(target.root)
      .then((list) => setBranches(hostBranches(list, target.remote)))
      .catch(() => setBranches([]));
    forgeDefaultBranch(cwd)
      .then((b) => b && setBase((prev) => prev || b))
      .catch(() => {});
  }, [cwd, target.root, target.remote]);

  const byName = useMemo(() => new Map((branches ?? []).map((b) => [b.name, b])), [branches]);
  const headBranch = byName.get(head);
  const same = !!head && head === base;

  // Qué entraría en el PR.
  useEffect(() => {
    const baseRef = compareRef(byName.get(base), target.remote, "base");
    const headRef = compareRef(byName.get(head), target.remote, "head");
    setCompare(null);
    setCompareError("");
    if (!baseRef || !headRef || same) return;
    let alive = true;
    setComparing(true);
    scmCompare(target.root, baseRef, headRef)
      .then((c) => { if (alive) setCompare(c); })
      .catch((e) => { if (alive) setCompareError(isScmError(e) ? e.message : String(e)); })
      .finally(() => { if (alive) setComparing(false); });
    return () => { alive = false; };
  }, [base, head, byName, same, target.root, target.remote]);

  // Título y descripción propuestos, hasta que se los toca.
  useEffect(() => {
    if (!compare) return;
    const commits = compare.commits;
    if (!titleEdited) {
      setTitle(commits.length === 1 ? commits[0].subject : titleFromBranch(head));
    }
    if (!bodyEdited) {
      const list = commits.length > 1
        ? [...commits].reverse().slice(0, BODY_COMMITS).map((c) => `- ${c.subject}`).join("\n")
        : "";
      setBody(list);
    }
  }, [compare, head, titleEdited, bodyEdited]);

  const swap = () => {
    setHead(base);
    setBase(head);
  };

  const needsPush = head === branch && !!headBranch?.local;
  const create = async () => {
    setError("");
    try {
      if (push && needsPush) {
        setBusy("push");
        // El push corre sobre el root del repo; `cwd` está adentro y git lo resuelve igual.
        await scmPush(cwd);
      }
      setBusy("create");
      onCreated(await forgeCreatePull(cwd, { title: title.trim(), body: body.trim() || undefined, head, base, draft }));
    } catch (e) {
      setError(isScmError(e) ? e.message : forgeErrorOf(e).message);
      setBusy(null);
    }
  };

  const empty = compare !== null && compare.commits.length === 0;
  const ready = !!title.trim() && !!head && !!base && !same && !empty;
  const loadingBranches = branches === null;

  return (
    <AppDialog
      title={t("forge.pr.new")}
      icon={<PullRequestIcon className="w-4 h-4 text-gray-500 dark:text-white/50" />}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <div className="flex items-center gap-3 w-full">
          <Switch checked={draft} onChange={setDraft} label={t("forge.pr.draft")} disabled={!!busy} />
          {needsPush && (
            <Switch checked={push} onChange={setPush} label={t("forge.pr.pushFirst")} disabled={!!busy} />
          )}
          <div className="flex-1" />
          <Button variant="outline" disabled={!!busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!!busy || !ready} onClick={create}>
            {busy === "push" ? t("forge.pr.pushing")
              : busy === "create" ? t("forge.working")
              : draft ? t("forge.pr.createDraft") : t("forge.pr.create")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Hacia dónde ← desde dónde, como lo muestra el host. */}
        <div className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-white/10
          bg-gray-50/70 dark:bg-white/3 p-3">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <BranchPicker label={t("forge.pr.base")} branches={branches ?? []} value={base} onChange={setBase}
              disabled={!!busy || loadingBranches} />
            <button
              type="button"
              onClick={swap}
              disabled={!!busy || !head || !base}
              title={t("forge.pr.swap")}
              aria-label={t("forge.pr.swap")}
              className="cc-t mb-1 flex items-center justify-center w-8 h-8 rounded-lg text-[15px]
                text-gray-400 dark:text-white/40 hover:text-gray-800 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40"
            >
              ←
            </button>
            <BranchPicker label={t("forge.pr.head")} branches={branches ?? []} value={head} onChange={setHead}
              disabled={!!busy || loadingBranches} error={same ? t("forge.pr.sameBranch") : undefined} />
          </div>
          <CompareSummary
            compare={compare}
            comparing={comparing || loadingBranches}
            error={compareError}
            base={base}
            head={head}
            notOnRemote={!!headBranch && !headBranch.remote}
          />
        </div>

        <Input
          label={t("forge.title")}
          value={title}
          onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }}
          variant="outline"
          disabled={!!busy}
          autoFocus
        />
        <MarkdownField
          label={t("forge.body")}
          value={body}
          onChange={(v) => { setBody(v); setBodyEdited(true); }}
          disabled={!!busy}
          rows={7}
          placeholder={t("forge.pr.bodyPlaceholder")}
        />

        {compare && compare.commits.length > 0 && <CommitList compare={compare} />}

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}

/** La línea de estado de la comparación: qué entra, o por qué no se puede abrir. */
function CompareSummary({ compare, comparing, error, base, head, notOnRemote }: {
  compare: Compare | null;
  comparing: boolean;
  error: string;
  base: string;
  head: string;
  notOnRemote: boolean;
}) {
  const { t } = useTranslation();
  const line = "flex items-center gap-1.5 text-[11.5px] min-w-0";

  if (!base || !head || base === head) return null;
  if (comparing) {
    return (
      <p className={`${line} text-gray-400 dark:text-white/40`}>
        <AnimateSpin className="w-3 h-3" /> {t("forge.pr.comparing")}
      </p>
    );
  }
  if (error) return <p className={`${line} text-red-500 dark:text-red-400 break-words`}>{t("forge.pr.compareFailed", { error })}</p>;
  if (!compare) return null;
  if (compare.commits.length === 0) {
    return <p className={`${line} text-amber-700 dark:text-amber-300`}>{t("forge.pr.nothing", { head, base })}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <p className={`${line} text-gray-600 dark:text-white/60`}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
        <span>
          {t("forge.pr.commitCount", { count: compare.commits.length, more: compare.truncated ? "+" : "" })}
          {" · "}
          {t("forge.pr.fileCount", { count: compare.files })}
        </span>
        <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">+{compare.insertions}</span>
        <span className="font-mono tabular-nums text-red-500 dark:text-red-400">−{compare.deletions}</span>
      </p>
      {compare.behind > 0 && (
        <p className={`${line} text-amber-700 dark:text-amber-300`}>
          {t("forge.pr.behind", { count: compare.behind, head, base })}
        </p>
      )}
      {notOnRemote && (
        <p className={`${line} text-gray-500 dark:text-white/45`}>
          <BranchIcon className="w-3 h-3 shrink-0" /> {t("forge.pr.notOnRemote", { branch: head })}
        </p>
      )}
    </div>
  );
}

/** Los commits que entran, del más viejo al más nuevo, como en la pestaña del host. */
function CommitList({ compare }: { compare: Compare }) {
  const { t } = useTranslation();
  const commits = [...compare.commits].reverse();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
        {t("forge.pr.commits")}
      </span>
      <div className="max-h-44 overflow-auto cc-scroll rounded-lg border border-gray-200 dark:border-white/10
        divide-y divide-gray-100 dark:divide-white/6">
        {commits.map((c) => (
          <div key={c.hash} className="flex items-center gap-2.5 px-3 py-1.5 min-w-0">
            <span className="shrink-0 font-mono text-[10.5px] text-gray-400 dark:text-white/35">{c.short}</span>
            <span className="flex-1 min-w-0 truncate text-[12px] text-gray-800 dark:text-gray-100" title={c.subject}>
              {c.subject}
            </span>
            <span className="shrink-0 max-w-[30%] truncate text-[11px] text-gray-400 dark:text-white/35">
              {c.author} · {elapsed(c.time * 1000)}
            </span>
          </div>
        ))}
        {compare.truncated && (
          <p className="px-3 py-1.5 text-[11px] text-gray-400 dark:text-white/35">{t("forge.pr.moreCommits")}</p>
        )}
      </div>
    </div>
  );
}
