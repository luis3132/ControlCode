import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge, Button, Select, Skeleton, TextArea } from "neogestify-ui-components";

import { BranchIcon, ExternalIcon } from "@/app/icons";
import { Markdown } from "@/shared/ui/Markdown";
import { AppDialog } from "@/shared/ui/AppDialog";
import { invalidateRepoInfo } from "@/features/workspaces/useRepoInfo";

import { forgeCheckoutPull, forgeComment, forgeItem, forgeMergePull } from "./ipc";
import { forgeErrorOf, type ForgeItem, type ForgeItemDetail } from "./types";

type MergeMethod = "merge" | "squash" | "rebase";

const STATE_VARIANT = { open: "success", merged: "accent", closed: "danger" } as const;

/**
 * Un PR o un issue entero: descripción, hilo de comentarios, y lo que se puede hacer sin
 * salir de la app — comentar, traer el PR como rama local para probarlo, fusionarlo.
 */
export function ItemDetailDialog({ cwd, item, pr, onClose, onChanged }: {
  cwd: string;
  item: ForgeItem;
  pr: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<ForgeItemDetail | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("merge");

  const load = useCallback(async () => {
    try {
      setDetail(await forgeItem(cwd, item.number, pr));
    } catch (e) {
      setError(forgeErrorOf(e).message);
    }
  }, [cwd, item.number, pr]);

  useEffect(() => { load(); }, [load]);

  const act = async (name: string, op: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await op();
    } catch (e) {
      setError(forgeErrorOf(e).message);
    } finally {
      setBusy(null);
    }
  };

  const shown = detail ?? { ...item, body: null, thread: [] };

  return (
    <AppDialog
      title={`${pr ? t("forge.pr.one") : t("forge.issue.one")} #${item.number}`}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      closeOnBackdrop={!busy && !comment.trim()}
      footer={
        <>
          <Button variant="outline" onClick={() => openUrl(item.webUrl).catch(console.error)}
            className="flex items-center gap-1.5 mr-auto">
            <ExternalIcon className="w-3 h-3" />
            {t("forge.openWeb")}
          </Button>
          {pr && shown.state === "open" && (
            <Button variant="outline" disabled={!!busy}
              onClick={() => act("checkout", async () => {
                const branch = await forgeCheckoutPull(cwd, item.number);
                invalidateRepoInfo(cwd);
                setNote(t("forge.pr.checkedOut", { branch }));
              })}
              className="flex items-center gap-1.5">
              <BranchIcon className="w-3 h-3" />
              {busy === "checkout" ? t("forge.working") : t("forge.pr.checkout")}
            </Button>
          )}
          {pr && shown.state === "open" && !merging && (
            <Button variant="primary" disabled={!!busy || shown.draft} onClick={() => setMerging(true)}>
              {t("forge.pr.merge")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-semibold leading-snug text-gray-900 dark:text-white">{shown.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/45">
            <Badge variant={STATE_VARIANT[shown.state]} size="sm">{t(`forge.filter.${shown.state}`)}</Badge>
            {shown.draft && <Badge variant="warning" size="sm">{t("forge.draft")}</Badge>}
            {shown.author && <span>@{shown.author}</span>}
            {shown.sourceBranch && shown.targetBranch && (
              <span className="font-mono">{shown.sourceBranch} → {shown.targetBranch}</span>
            )}
            {shown.labels.map((l) => <Badge key={l} variant="neutral" size="sm">{l}</Badge>)}
          </div>
        </div>

        {merging && (
          <div className="flex items-end gap-2 p-2.5 rounded-lg bg-violet-50 dark:bg-violet-500/10
            border border-violet-200 dark:border-violet-500/25">
            <div className="flex-1">
              <Select
                label={t("forge.pr.mergeMethod")}
                value={method}
                onChange={(e) => setMethod(e.target.value as MergeMethod)}
                options={[
                  { value: "merge", label: t("forge.pr.method.merge") },
                  { value: "squash", label: t("forge.pr.method.squash") },
                  { value: "rebase", label: t("forge.pr.method.rebase") },
                ]}
                variant="outline"
              />
            </div>
            <Button variant="outline" onClick={() => setMerging(false)}>{t("btn.cancel")}</Button>
            <Button variant="primary" disabled={!!busy}
              onClick={() => act("merge", async () => {
                await forgeMergePull(cwd, item.number, method);
                setMerging(false);
                await load();
                onChanged();
              })}>
              {busy === "merge" ? t("forge.working") : t("forge.pr.confirmMerge")}
            </Button>
          </div>
        )}

        {note && <p className="text-[11.5px] text-emerald-600 dark:text-emerald-400">{note}</p>}
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}

        <div className="rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2.5 text-[12.5px]">
          {detail === null && !error ? (
            <div className="flex flex-col gap-2">
              {[90, 70, 80].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
            </div>
          ) : shown.body ? (
            <Markdown content={shown.body} />
          ) : (
            <p className="text-gray-400 dark:text-white/35 italic">{t("forge.noDescription")}</p>
          )}
        </div>

        {shown.thread.map((c, i) => (
          <div key={i} className="rounded-lg bg-gray-50 dark:bg-white/3 px-3 py-2 text-[12px]">
            <div className="mb-1 text-[10.5px] text-gray-500 dark:text-white/40">
              @{c.author ?? "?"}{c.createdAt && ` · ${new Date(c.createdAt).toLocaleString()}`}
            </div>
            <Markdown content={c.body} />
          </div>
        ))}

        <TextArea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t("forge.comment.placeholder")}
          variant="outline"
          rows={3}
          resize="none"
        />
        <div className="flex justify-end">
          <Button size="sm" variant="primary" disabled={!!busy || !comment.trim()}
            onClick={() => act("comment", async () => {
              await forgeComment(cwd, item.number, pr, comment);
              setComment("");
              await load();
              onChanged();
            })}>
            {busy === "comment" ? t("forge.working") : t("forge.comment.send")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
