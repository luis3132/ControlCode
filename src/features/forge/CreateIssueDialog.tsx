import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Skeleton } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { IssueIcon } from "@/app/icons";

import { MarkdownField } from "./composer";
import { forgeCreateIssue, forgeLabels } from "./ipc";
import { forgeErrorOf, type ForgeItem, type ForgeKind, type Label } from "./types";

/**
 * Abrir un issue. Las etiquetas se eligen de las que tiene el repo, con sus colores, y se
 * puede escribir una que no esté en la lista.
 */
export function CreateIssueDialog({ cwd, kind, onClose, onCreated }: {
  cwd: string;
  kind: ForgeKind | null;
  onClose: () => void;
  onCreated: (item: ForgeItem) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [repoLabels, setRepoLabels] = useState<Label[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Gitea pide las etiquetas por id al crear el issue, y la app las manda por nombre.
  const labelsIgnored = kind === "gitea";

  useEffect(() => {
    forgeLabels(cwd).then(setRepoLabels).catch(() => setRepoLabels([]));
  }, [cwd]);

  const toggle = (name: string) =>
    setLabels((prev) => prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated(await forgeCreateIssue(cwd, { title: title.trim(), body: body.trim() || undefined, labels }));
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("forge.issue.new")}
      icon={<IssueIcon className="w-4 h-4 text-gray-500 dark:text-white/50" />}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={create}>
            {busy ? t("forge.working") : t("forge.issue.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label={t("forge.title")} value={title} onChange={(e) => setTitle(e.target.value)}
          variant="outline" disabled={busy} autoFocus placeholder={t("forge.issue.titlePlaceholder")} />
        <MarkdownField label={t("forge.body")} value={body} onChange={setBody} disabled={busy} rows={9}
          placeholder={t("forge.issue.bodyPlaceholder")} />
        {!labelsIgnored && (
          <LabelPicker repoLabels={repoLabels} selected={labels} onToggle={toggle} disabled={busy} />
        )}
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}

function LabelPicker({ repoLabels, selected, onToggle, disabled }: {
  repoLabels: Label[] | null;
  selected: string[];
  onToggle: (name: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const known = new Set((repoLabels ?? []).map((l) => l.name));
  // Las escritas a mano que el repo no tiene también se muestran, para poder quitarlas.
  const extra: Label[] = selected.filter((n) => !known.has(n)).map((name) => ({ name, color: null, description: null }));
  const all = [...(repoLabels ?? []), ...extra];

  const add = () => {
    const name = draft.trim();
    if (name && !selected.includes(name)) onToggle(name);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
        {t("forge.issue.labels")}
        {selected.length > 0 && (
          <span className="ml-1.5 font-normal text-gray-400 dark:text-white/35">{selected.length}</span>
        )}
      </span>
      {repoLabels === null ? (
        <div className="flex gap-1.5">
          {[56, 72, 48].map((w) => <Skeleton key={w} className="h-6 rounded-full" style={{ width: w }} />)}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {all.map((label) => (
            <LabelChip key={label.name} label={label} on={selected.includes(label.name)}
              onClick={() => onToggle(label.name)} disabled={disabled} />
          ))}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
            }}
            onBlur={add}
            disabled={disabled}
            placeholder={all.length ? t("forge.issue.addLabel") : t("forge.issue.noLabels")}
            className="h-6 min-w-32 flex-1 bg-transparent px-1 text-[12px] text-gray-800 dark:text-gray-100
              placeholder:text-gray-400 dark:placeholder:text-white/30 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}

/** Una etiqueta con el color que tiene en el host. Apagada hasta que se la elige. */
function LabelChip({ label, on, onClick, disabled }: {
  label: Label;
  on: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const color = label.color && /^[0-9a-f]{6}$/i.test(label.color) ? `#${label.color}` : null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label.description ?? label.name}
      aria-pressed={on}
      className={`cc-t inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11.5px] font-medium
        ${on
          ? "border-transparent text-gray-900 dark:text-white"
          : "border-gray-200 dark:border-white/10 text-gray-500 dark:text-white/50 hover:border-gray-300 dark:hover:border-white/25"}`}
      style={on && color ? { backgroundColor: `${color}33`, boxShadow: `inset 0 0 0 1px ${color}` } : undefined}
    >
      <span className="w-2 h-2 rounded-full shrink-0 bg-gray-400" style={color ? { backgroundColor: color } : undefined} />
      {label.name}
      {on && <span aria-hidden className="text-[10px] opacity-60">✕</span>}
    </button>
  );
}
