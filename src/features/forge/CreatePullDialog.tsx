import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Switch, TextArea } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { scmPush } from "@/features/scm/ipc";
import { isScmError } from "@/features/scm/types";

import { forgeCreatePull, forgeDefaultBranch } from "./ipc";
import { forgeErrorOf, type ForgeItem } from "./types";

/**
 * Abrir un PR desde la rama actual.
 *
 * Sube la rama antes (con la cuenta de la app): el host no deja abrir un PR de una rama
 * que no tiene, y "primero hacé push" es un paso que nadie quiere tener que recordar.
 */
export function CreatePullDialog({ cwd, branch, onClose, onCreated }: {
  cwd: string;
  branch: string | null;
  onClose: () => void;
  onCreated: (item: ForgeItem) => void;
}) {
  const { t } = useTranslation();
  const [head, setHead] = useState(branch ?? "");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState<"push" | "create" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    forgeDefaultBranch(cwd).then((b) => b && setBase((prev) => prev || b)).catch(() => {});
  }, [cwd]);

  const create = async () => {
    setError("");
    try {
      if (push && head === branch) {
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

  const ready = !!title.trim() && !!head.trim() && !!base.trim() && head !== base;

  return (
    <AppDialog
      title={t("forge.pr.new")}
      onClose={onClose}
      size="md"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={!!busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!!busy || !ready} onClick={create}>
            {busy === "push" ? t("forge.pr.pushing") : busy === "create" ? t("forge.working") : t("forge.pr.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Input label={t("forge.pr.head")} value={head} onChange={(e) => setHead(e.target.value)}
            variant="outline" disabled={!!busy} />
          <Input label={t("forge.pr.base")} value={base} onChange={(e) => setBase(e.target.value)}
            variant="outline" disabled={!!busy} error={head && head === base ? t("forge.pr.sameBranch") : undefined} />
        </div>
        <Input label={t("forge.title")} value={title} onChange={(e) => setTitle(e.target.value)}
          variant="outline" disabled={!!busy} autoFocus />
        <TextArea label={t("forge.body")} value={body} onChange={(e) => setBody(e.target.value)}
          variant="outline" rows={6} resize="none" disabled={!!busy} placeholder={t("forge.bodyPlaceholder")} />
        <Switch checked={draft} onChange={setDraft} label={t("forge.pr.draft")} disabled={!!busy} />
        {head === branch && (
          <Switch checked={push} onChange={setPush} label={t("forge.pr.pushFirst")} disabled={!!busy} />
        )}
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
