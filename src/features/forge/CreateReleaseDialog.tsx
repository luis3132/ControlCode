import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Switch } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { TagIcon } from "@/app/icons";
import { readFile } from "@/features/editor/ipc";
import { scmBranches, scmCompare, scmTags } from "@/features/scm/ipc";
import { versionSteps } from "@/features/scm/nextVersion";

import { BranchPicker, compareRef, FieldAction, hostBranches, MarkdownField, type HostBranch } from "./composer";
import { forgeCreateRelease, forgeDefaultBranch } from "./ipc";
import { forgeErrorOf, type ForgeKind, type Release, type RepoTarget } from "./types";

/**
 * Publicar una release en el host. Si el tag todavía no existe allá, el host lo crea en la
 * rama que se elija (por defecto, la rama por defecto).
 *
 * Las notas se pueden escribir, tomar de `.github/releases/<tag>.md` si el repo las tiene
 * (como este: son las mismas que usaría su workflow), o armar desde los commits que hay
 * desde la release anterior.
 */
export function CreateReleaseDialog({ cwd, target, kind, onClose, onCreated }: {
  cwd: string;
  target: RepoTarget;
  kind: ForgeKind | null;
  onClose: () => void;
  onCreated: (release: Release) => void;
}) {
  const { t } = useTranslation();
  const root = target.root;
  const [tags, setTags] = useState<string[]>([]);
  const [branches, setBranches] = useState<HostBranch[]>([]);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [notesFile, setNotesFile] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gitlab = kind === "gitlab";

  useEffect(() => {
    scmTags(root).then((list) => {
      const names = list.map((tg) => tg.name);
      setTags(names);
      setTag((prev) => prev || versionSteps(names).next[0]);
    }).catch(() => setTag((prev) => prev || "v0.1.0"));
    scmBranches(root).then((list) => setBranches(hostBranches(list, target.remote))).catch(() => {});
    forgeDefaultBranch(cwd).then((b) => b && setTargetBranch((prev) => prev || b)).catch(() => {});
  }, [root, cwd, target.remote]);

  const steps = useMemo(() => versionSteps(tags), [tags]);
  const trimmed = tag.trim();
  const exists = tags.includes(trimmed);

  // Notas ya escritas para este tag, si el repo las tiene.
  useEffect(() => {
    let alive = true;
    if (!trimmed || trimmed.includes("..") || trimmed.includes("/")) { setNotesFile(null); return; }
    readFile(`${root}/.github/releases/${trimmed}.md`)
      .then((c) => { if (alive) setNotesFile(c.kind === "text" ? c.content : null); })
      .catch(() => { if (alive) setNotesFile(null); });
    return () => { alive = false; };
  }, [root, trimmed]);

  /** Una lista con los commits desde la última versión hasta el destino. */
  const generate = async () => {
    const since = steps.latest;
    const to = compareRef(branches.find((b) => b.name === targetBranch), target.remote, "base") ?? targetBranch;
    if (!since || !to) return;
    setGenerating(true);
    setNote("");
    try {
      const cmp = await scmCompare(root, since, to);
      if (cmp.commits.length === 0) {
        setNote(t("forge.release.noCommitsSince", { tag: since }));
      } else {
        const lines = [...cmp.commits].reverse().map((c) => `- ${c.subject} (${c.short})`);
        setBody(`## ${t("forge.release.changesHeading")}\n\n${lines.join("\n")}\n`);
      }
    } catch (e) {
      setNote(String((e as { message?: string })?.message ?? e));
    } finally {
      setGenerating(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated(await forgeCreateRelease(cwd, {
        tag: trimmed,
        name: name.trim() || undefined,
        body: body.trim() || undefined,
        target: exists ? undefined : targetBranch.trim() || undefined,
        draft,
        prerelease,
      }));
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  const chip = (value: string, hint: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setTag(value)}
      disabled={busy}
      className={`cc-t inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11.5px]
        ${trimmed === value
          ? "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : "border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/60 hover:border-gray-300 dark:hover:border-white/25"}`}
    >
      <span className="font-mono">{value}</span>
      <span className="text-[10.5px] opacity-60">{hint}</span>
    </button>
  );

  return (
    <AppDialog
      title={t("forge.release.new")}
      icon={<TagIcon className="w-4 h-4 text-gray-500 dark:text-white/50" />}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <div className="flex items-center gap-3 w-full">
          {!gitlab && <Switch checked={draft} onChange={setDraft} label={t("forge.release.draft")} disabled={busy} />}
          <Switch checked={prerelease} onChange={setPrerelease} label={t("forge.release.prerelease")} disabled={busy} />
          <div className="flex-1" />
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !trimmed} onClick={create}>
            {busy ? t("forge.working") : draft ? t("forge.release.saveDraft") : t("forge.release.publish")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-xl border border-gray-200 dark:border-white/10
          bg-gray-50/70 dark:bg-white/3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Input label={t("forge.release.tag")} value={tag} onChange={(e) => setTag(e.target.value)}
              variant="outline" disabled={busy} autoFocus className="!font-mono"
              helperText={exists ? t("forge.release.tagExists") : t("forge.release.tagNew")} />
            <BranchPicker label={t("forge.release.target")} branches={branches} value={targetBranch}
              onChange={setTargetBranch} disabled={busy || exists} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {steps.latest && (
              <span className="mr-1 text-[11px] text-gray-400 dark:text-white/35">
                {t("forge.release.latest")} <span className="font-mono">{steps.latest}</span>
              </span>
            )}
            {steps.next.map((v, i) => chip(v, steps.latest
              ? t(["forge.release.patch", "forge.release.minor", "forge.release.major"][i])
              : ""))}
          </div>
        </div>

        <Input label={t("forge.title")} value={name} onChange={(e) => setName(e.target.value)}
          variant="outline" disabled={busy} placeholder={trimmed || "v1.0.0"} />

        <div className="flex flex-col gap-1">
          <MarkdownField
            label={t("forge.release.notes")}
            value={body}
            onChange={setBody}
            disabled={busy}
            rows={10}
            placeholder={t("forge.bodyPlaceholder")}
            actions={
              <div className="flex items-center gap-3 min-w-0">
                {notesFile !== null && (
                  <FieldAction onClick={() => setBody(notesFile)} disabled={busy}
                    title={`.github/releases/${trimmed}.md`}>
                    {t("forge.release.useNotesShort")}
                  </FieldAction>
                )}
                {steps.latest && (
                  <FieldAction onClick={() => void generate()} disabled={busy || generating || !targetBranch}>
                    {generating ? t("forge.working") : t("forge.release.fromCommits", { tag: steps.latest })}
                  </FieldAction>
                )}
              </div>
            }
          />
          {note && <p className="text-[11px] text-amber-700 dark:text-amber-300">{note}</p>}
        </div>

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
