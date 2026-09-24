import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AddGitAccountDialog } from "./AddGitAccountDialog";
import { ForgeIcon } from "./forgeMeta";
import { forgeSetRepoAccount } from "./ipc";
import type { RepoTarget } from "./types";

/** "Iniciar sesión en <host>" con el tipo y el host ya puestos. */
export function SignInButton({ target, label, variant = "primary" }: {
  target: Pick<RepoTarget, "host" | "kind">;
  label?: string;
  variant?: "primary" | "outline";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label ?? t("forge.signIn", { host: target.host })}
      </Button>
      {open && <AddGitAccountDialog kind={target.kind} host={target.host} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Con qué cuenta trabaja este repo. Si hay varias para su host (personal y trabajo), acá
 * se elige, y la elección queda guardada para ese repo.
 */
export function RepoAccountBar({ target, onChanged }: { target: RepoTarget; onChanged: () => void }) {
  const { t } = useTranslation();
  const account = target.account;

  return (
    <div className="flex items-center gap-1.5 h-7 shrink-0 px-3 border-b border-gray-200 dark:border-white/7">
      <ForgeIcon kind={target.kind} className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-white/45" />
      <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-500 dark:text-white/40" title={target.remoteUrl}>
        {target.path}
      </span>
      {account && target.accounts.length > 1 ? (
        <select
          value={account.id}
          onChange={async (e) => {
            await forgeSetRepoAccount(target.root, e.target.value).catch(console.error);
            onChanged();
          }}
          title={t("forge.pickAccount")}
          className="max-w-[45%] h-5 px-1 rounded text-[10.5px] outline-none
            bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/8"
        >
          {target.accounts.map((a) => <option key={a.id} value={a.id}>@{a.login}</option>)}
        </select>
      ) : account ? (
        <span className="shrink-0 max-w-[45%] truncate text-[10.5px] text-gray-600 dark:text-gray-300" title={account.host}>
          @{account.login}
        </span>
      ) : null}
    </div>
  );
}
