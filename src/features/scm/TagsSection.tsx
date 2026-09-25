import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, Button, ChevronDownIcon, ChevronRightIcon, Tooltip, TrashIcon } from "neogestify-ui-components";

import { PushIcon, TagIcon } from "@/app/icons";
import { AppDialog } from "@/shared/ui/AppDialog";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { scmDeleteTag, scmPushTag, scmTags } from "./ipc";
import { isScmError, type Tag } from "./types";

/**
 * Los tags del repo, plegable como el historial: subir uno al remoto (con la cuenta de la
 * app) o borrarlo en local. Crear uno se hace desde "+" (en HEAD) o desde un commit del
 * grafo.
 */
export function TagsSection({ root, version, onCreate, onChanged }: {
  root: string;
  /** Cambia cuando se creó un tag desde afuera: hay que releer. */
  version: number;
  onCreate: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);

  const load = useCallback(() => {
    scmTags(root).then(setTags).catch(() => setTags([]));
  }, [root]);

  useEffect(() => { if (open) load(); }, [open, load, version]);

  const act = async (tag: Tag, kind: "push" | "delete") => {
    setBusy(tag.name);
    setNote(null);
    try {
      if (kind === "push") {
        await scmPushTag(root, tag.name);
        setNote({ error: false, text: t("scm.tag.pushed", { name: tag.name }) });
      } else {
        await scmDeleteTag(root, tag.name);
      }
      load();
      onChanged();
    } catch (e) {
      setNote({ error: true, text: isScmError(e) ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-white/7">
      <div className="group flex items-center gap-1 h-7 pl-1.5 pr-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 flex-1 min-w-0 h-full text-left">
          <span className="w-3.5 shrink-0 text-gray-400 dark:text-white/30">
            {open ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
          </span>
          <span className="flex-1 text-[10px] font-extrabold uppercase tracking-[0.09em] text-gray-500 dark:text-white/40">
            {t("scm.tags")}
          </span>
        </button>
        <Tooltip content={t("scm.tag.createHead")} placement="left">
          <button onClick={onCreate} aria-label={t("scm.tag.createHead")}
            className="cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md text-gray-400 dark:text-white/40
              hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <AddIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      {open && (
        <div className="max-h-48 cc-scroll pb-1">
          {note && (
            <p className={`px-3 py-1 text-[10.5px] break-words
              ${note.error ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
              {note.text}
            </p>
          )}
          {tags === null ? (
            <p className="px-3 py-2 text-[11px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
          ) : tags.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-gray-400 dark:text-white/30">{t("scm.tag.none")}</p>
          ) : tags.map((tag) => (
            <div key={tag.name} title={`${tag.name} → ${tag.target}\n${tag.subject}`}
              className="group flex items-center gap-1.5 h-[24px] pl-3 pr-2 hover:bg-gray-200/50 dark:hover:bg-white/4">
              <TagIcon className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="shrink-0 max-w-[45%] truncate font-mono text-[11px] text-gray-800 dark:text-gray-200">{tag.name}</span>
              <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/30">{tag.subject}</span>
              <span className="hidden group-hover:flex items-center gap-0.5">
                <Tooltip content={t("scm.tag.pushOne")} placement="left">
                  <button onClick={() => act(tag, "push")} disabled={!!busy} aria-label={t("scm.tag.pushOne")}
                    className="cc-t flex items-center justify-center w-5 h-5 rounded text-gray-400 dark:text-white/40
                      hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40">
                    <PushIcon className="w-3 h-3" />
                  </button>
                </Tooltip>
                <Tooltip content={t("scm.tag.deleteLocal")} placement="left">
                  <button onClick={() => setDeleting(tag)} disabled={!!busy} aria-label={t("scm.tag.deleteLocal")}
                    className="cc-t flex items-center justify-center w-5 h-5 rounded text-gray-400 dark:text-white/40
                      hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40">
                    <TrashIcon className="w-3 h-3" />
                  </button>
                </Tooltip>
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30 group-hover:hidden">
                {busy === tag.name ? "…" : elapsed(tag.time * 1000)}
              </span>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <AppDialog
          title={t("scm.tag.deleteTitle", { name: deleting.name })}
          onClose={() => setDeleting(null)}
          size="sm"
          closeOnEsc
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={() => { const tag = deleting; setDeleting(null); act(tag, "delete"); }}>
                {t("scm.tag.deleteLocal")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("scm.tag.deleteBody")}</p>
        </AppDialog>
      )}
    </div>
  );
}
