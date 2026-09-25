import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Switch, TextArea } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { readFile } from "@/features/editor/ipc";
import { scmTags } from "@/features/scm/ipc";
import { nextVersion } from "@/features/scm/nextVersion";

import { forgeCreateRelease, forgeDefaultBranch } from "./ipc";
import { forgeErrorOf, type ForgeKind, type Release } from "./types";

/**
 * Publicar una release en el host. Si el tag todavía no existe allá, el host lo crea en la
 * rama o commit que se diga (por defecto, la rama por defecto).
 *
 * Si el repo tiene las notas escritas en `.github/releases/<tag>.md` (como este), se
 * ofrecen: son las mismas que usaría su workflow.
 */
export function CreateReleaseDialog({ cwd, root, kind, onClose, onCreated }: {
  cwd: string;
  root: string;
  kind: ForgeKind | null;
  onClose: () => void;
  onCreated: (release: Release) => void;
}) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [notesFile, setNotesFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gitlab = kind === "gitlab";

  useEffect(() => {
    scmTags(root).then((list) => {
      const names = list.map((tg) => tg.name);
      setTags(names);
      setTag((prev) => prev || nextVersion(names));
    }).catch(() => setTag((prev) => prev || "v0.1.0"));
    forgeDefaultBranch(cwd).then((b) => b && setTarget((prev) => prev || b)).catch(() => {});
  }, [root, cwd]);

  // Notas ya escritas para este tag, si el repo las tiene.
  useEffect(() => {
    let alive = true;
    const name = tag.trim();
    if (!name || name.includes("..")) { setNotesFile(null); return; }
    readFile(`${root}/.github/releases/${name}.md`)
      .then((c) => { if (alive) setNotesFile(c.kind === "text" ? c.content : null); })
      .catch(() => { if (alive) setNotesFile(null); });
    return () => { alive = false; };
  }, [root, tag]);

  const exists = tags.includes(tag.trim());

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated(await forgeCreateRelease(cwd, {
        tag: tag.trim(),
        name: name.trim() || undefined,
        body: body.trim() || undefined,
        target: exists ? undefined : target.trim() || undefined,
        draft,
        prerelease,
      }));
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("forge.release.new")}
      onClose={onClose}
      size="md"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !tag.trim()} onClick={create}>
            {busy ? t("forge.working") : draft ? t("forge.release.saveDraft") : t("forge.release.publish")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label={t("forge.release.tag")} value={tag} onChange={(e) => setTag(e.target.value)}
            variant="outline" disabled={busy} list="cc-release-tags" autoFocus
            helperText={exists ? t("forge.release.tagExists") : t("forge.release.tagNew")} />
          <datalist id="cc-release-tags">{tags.map((tg) => <option key={tg} value={tg} />)}</datalist>
          <Input label={t("forge.release.target")} value={target} onChange={(e) => setTarget(e.target.value)}
            variant="outline" disabled={busy || exists}
            helperText={exists ? t("forge.release.targetUnused") : undefined} />
        </div>
        <Input label={t("forge.title")} value={name} onChange={(e) => setName(e.target.value)}
          variant="outline" disabled={busy} placeholder={tag || "v1.0.0"} />
        <div className="flex flex-col gap-1">
          <TextArea label={t("forge.release.notes")} value={body} onChange={(e) => setBody(e.target.value)}
            variant="outline" rows={8} resize="none" disabled={busy} placeholder={t("forge.bodyPlaceholder")} />
          {notesFile !== null && (
            <button
              onClick={() => setBody(notesFile)}
              disabled={busy}
              className="self-start text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t("forge.release.useNotes", { file: `.github/releases/${tag.trim()}.md` })}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          {!gitlab && <Switch checked={draft} onChange={setDraft} label={t("forge.release.draft")} disabled={busy} />}
          <Switch checked={prerelease} onChange={setPrerelease} label={t("forge.release.prerelease")} disabled={busy} />
        </div>
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
