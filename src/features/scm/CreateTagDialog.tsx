import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Switch, TextArea } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { scmCreateTag, scmPushTag, scmTags } from "./ipc";
import { nextVersion } from "./nextVersion";
import { isScmError } from "./types";

/**
 * Crear un tag en un commit (o en HEAD) y, si se quiere, subirlo.
 *
 * Con mensaje es anotado, que es lo que usan las releases. Subirlo va con la cuenta de git
 * de la app: en un repo cuyo CI publica al llegar un tag, esto es sacar la release.
 */
export function CreateTagDialog({ root, target, onClose, onDone }: {
  root: string;
  /** El commit; `null` = HEAD. */
  target: { hash: string; short: string; subject: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState<"create" | "push" | null>(null);
  const [error, setError] = useState("");

  // Propone la versión siguiente a la última que haya.
  useEffect(() => {
    scmTags(root).then((tags) => setName((prev) => prev || nextVersion(tags.map((tg) => tg.name)))).catch(() => {});
  }, [root]);

  /** El tag ya existe en local (se creó y falló subirlo): el botón solo reintenta subir. */
  const [created, setCreated] = useState(false);

  const create = async () => {
    setError("");
    let stage: "create" | "push" = "create";
    try {
      if (!created) {
        setBusy("create");
        await scmCreateTag(root, name.trim(), target?.hash ?? null, message.trim() || null);
        setCreated(true);
      }
      if (push) {
        stage = "push";
        setBusy("push");
        await scmPushTag(root, name.trim());
      }
      onDone();
    } catch (e) {
      const text = isScmError(e) ? e.message : String(e);
      setError(stage === "push" ? t("scm.tag.pushFailed", { error: text }) : text);
      setBusy(null);
    }
  };

  return (
    <AppDialog
      title={t("scm.tag.create")}
      onClose={onClose}
      size="sm"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={!!busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!!busy || !name.trim()} onClick={create}>
            {busy === "push" ? t("scm.tag.pushing") : busy ? t("forge.working") : created ? t("scm.tag.retryPush") : t("scm.tag.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[11.5px] text-gray-500 dark:text-white/45 truncate">
          {target
            ? t("scm.tag.onCommit", { commit: target.short, subject: target.subject })
            : t("scm.tag.onHead")}
        </p>
        <Input label={t("scm.tag.name")} value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
          variant="outline" disabled={!!busy || created} autoFocus placeholder="v1.0.0" />
        <TextArea label={t("scm.tag.message")} value={message} onChange={(e) => setMessage(e.target.value)}
          variant="outline" rows={3} resize="none" disabled={!!busy || created} helperText={t("scm.tag.messageHelper")} />
        <Switch checked={push} onChange={setPush} label={t("scm.tag.push")} disabled={!!busy} />
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
