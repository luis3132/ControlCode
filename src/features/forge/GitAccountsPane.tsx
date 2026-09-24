import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, Avatar, Badge, Button, EmptyState, InfoIcon, Tooltip, TrashIcon } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { AddGitAccountDialog } from "./AddGitAccountDialog";
import { ForgeIcon, forgeLabel } from "./forgeMeta";
import { useForgeStore } from "./store";
import type { ForgeKind, GitAccount } from "./types";

function GitAccountRow({ account, onRemove }: { account: GitAccount; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cc-t flex items-center gap-3 px-3 h-12 rounded-lg
      bg-white dark:bg-white/4 hover:bg-gray-50 dark:hover:bg-white/6">
      {account.avatarUrl ? (
        <img src={account.avatarUrl} alt="" className="w-7 h-7 rounded-md shrink-0 object-cover" />
      ) : (
        <Avatar name={account.login} size="sm" shape="square" />
      )}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
            {account.login}
          </span>
          {account.name && (
            <span className="truncate text-[11px] text-gray-400 dark:text-white/35">{account.name}</span>
          )}
        </div>
        <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
          {account.host} · {t(account.auth === "oauth" ? "forge.auth.oauth" : "forge.auth.token")}
        </span>
      </div>
      {/* Sin llavero del sistema el token quedó en un archivo: se avisa, no se esconde. */}
      {account.storage === "file" && (
        <Tooltip content={t("forge.storage.fileHint")} placement="left">
          <span><Badge variant="warning" size="sm" className="shrink-0">{t("forge.storage.file")}</Badge></span>
        </Tooltip>
      )}
      <Tooltip content={t("forge.signOut")} placement="left">
        <button
          onClick={onRemove}
          aria-label={t("forge.signOut")}
          className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
            text-gray-400 dark:text-white/35 hover:text-red-500 dark:hover:text-red-400
            hover:bg-gray-200 dark:hover:bg-white/10"
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * Las cuentas de un tipo de host git. A diferencia de las de las TUIs, acá SÍ hay
 * credenciales: un token por cuenta, guardado en el llavero del sistema.
 */
export function GitAccountsPane({ kind }: { kind: ForgeKind }) {
  const { t } = useTranslation();
  const accounts = useForgeStore((s) => s.accounts);
  const remove = useForgeStore((s) => s.remove);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GitAccount | null>(null);
  const [error, setError] = useState("");
  const rows = useMemo(() => accounts.filter((a) => a.kind === kind), [accounts, kind]);
  const label = forgeLabel(kind, t);

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await remove(removing.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 h-9 shrink-0 px-4 border-b border-gray-200 dark:border-white/8">
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-semibold text-gray-700 dark:text-gray-300">
          {t("forge.accountsOf", { provider: label })}
        </span>
        <Tooltip content={t("forge.add.action")} placement="bottom">
          <button
            onClick={() => setAdding(true)}
            aria-label={t("forge.add.action")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <AddIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 cc-scroll flex flex-col gap-1.5 p-3">
        {rows.length === 0 ? (
          <EmptyState
            className="m-auto"
            icon={<ForgeIcon kind={kind} className="w-7 h-7" />}
            title={t("forge.empty", { provider: label })}
            description={t(kind === "other" ? "forge.empty.descOther" : "forge.empty.desc")}
            action={
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                {t("forge.add.action")}
              </Button>
            }
          />
        ) : (
          rows.map((a) => <GitAccountRow key={a.id} account={a} onRemove={() => setRemoving(a)} />)
        )}
      </div>

      {error && <p className="shrink-0 px-4 pb-2 text-[11px] text-red-500 dark:text-red-400">{error}</p>}

      <div className="flex items-start gap-2 shrink-0 px-4 py-2
        border-t border-gray-200 dark:border-white/8 bg-gray-100/60 dark:bg-black/20
        text-[10.5px] text-gray-400 dark:text-white/35">
        <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0" />
        <span>{t("forge.paneNote")}</span>
      </div>

      {adding && <AddGitAccountDialog kind={kind} onClose={() => setAdding(false)} />}

      {removing && (
        <AppDialog
          title={t("forge.signOut.title", { login: removing.login, host: removing.host })}
          onClose={() => setRemoving(null)}
          size="sm"
          closeOnEsc
          footer={
            <>
              <Button variant="outline" onClick={() => setRemoving(null)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={confirmRemove}>{t("forge.signOut")}</Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("forge.signOut.body")}</p>
        </AppDialog>
      )}
    </>
  );
}
