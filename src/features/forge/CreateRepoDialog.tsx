import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, Select, Switch } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { AddGitAccountDialog } from "./AddGitAccountDialog";
import { forgeCreateRepo, forgeOwners } from "./ipc";
import { suggestRepoName, validRepoName } from "./repoName";
import { useForgeStore } from "./store";
import { forgeErrorOf, type ForgeRepo, type RepoOwner } from "./types";

/**
 * Crear en GitHub, GitLab o Gitea el repo de una carpeta, con una cuenta de la app.
 *
 * Sirve para un proyecto que todavía no es un repo (se inicializa y se hace el primer
 * commit con lo que tenga) y para un repo local que no tiene remoto (se le agrega). En los
 * dos, el repo nuevo queda como `origin` y la rama se sube.
 */
export function CreateRepoDialog({ cwd, isRepo, onClose, onCreated }: {
  cwd: string;
  /** `false` = la carpeta no es un repo todavía: se va a inicializar. */
  isRepo: boolean;
  onClose: () => void;
  onCreated: (repo: ForgeRepo) => void;
}) {
  const { t } = useTranslation();
  const accounts = useForgeStore((s) => s.accounts);
  const loaded = useForgeStore((s) => s.loaded);
  const load = useForgeStore((s) => s.load);
  // Un host genérico no tiene API: no se puede crear nada ahí.
  const apiAccounts = useMemo(() => accounts.filter((a) => a.kind !== "other"), [accounts]);
  const [accountId, setAccountId] = useState("");
  const [owners, setOwners] = useState<RepoOwner[] | null>(null);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(() => suggestRepoName(cwd));
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);
  useEffect(() => {
    if (!accountId && apiAccounts[0]) setAccountId(apiAccounts[0].id);
  }, [accountId, apiAccounts]);

  // Dónde se puede crear con esa cuenta: ella misma y sus organizaciones.
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    setOwners(null);
    setError("");
    forgeOwners(accountId)
      .then((list) => {
        if (!alive) return;
        setOwners(list);
        setOwner(list[0]?.login ?? "");
      })
      .catch((e) => { if (alive) { setOwners([]); setError(forgeErrorOf(e).message); } });
    return () => { alive = false; };
  }, [accountId]);

  const account = apiAccounts.find((a) => a.id === accountId);
  const nameOk = validRepoName(name.trim());
  const ready = !!account && owners !== null && !!owner && nameOk;

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const repo = await forgeCreateRepo({
        cwd,
        accountId,
        owner: owners?.find((o) => o.login === owner) ?? null,
        name: name.trim(),
        description: description.trim() || null,
        private: isPrivate,
      });
      onCreated(repo);
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("forge.create.title")}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={create} className="flex items-center gap-1.5">
            {busy && <AnimateSpin className="w-3.5 h-3.5" />}
            {busy ? t("forge.create.creating") : t("forge.create.action")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-gray-500 dark:text-white/50">
          {t(isRepo ? "forge.create.helpRepo" : "forge.create.helpInit")}
        </p>

        {loaded && apiAccounts.length === 0 ? (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 dark:border-white/8">
            <span className="text-[12px] text-gray-600 dark:text-gray-300">{t("forge.create.noAccount")}</span>
            <Button variant="primary" onClick={() => setAdding(true)}>{t("forge.add.action")}</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <Select
                  label={t("forge.create.account")}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  options={apiAccounts.map((a) => ({ value: a.id, label: `@${a.login} · ${a.host}` }))}
                  variant="outline"
                  disabled={busy}
                />
              </div>
              <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>{t("forge.add.action")}</Button>
            </div>
            <Select
              label={t("forge.create.owner")}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              options={(owners ?? []).map((o) => ({
                value: o.login,
                label: o.org ? o.login : t("forge.create.ownerMe", { login: o.login }),
              }))}
              variant="outline"
              disabled={busy || owners === null}
            />
          </div>
        )}

        <Input
          label={t("forge.create.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          variant="outline"
          disabled={busy}
          autoFocus
          helperText={owner && nameOk ? `${account?.host ?? ""}/${owner}/${name.trim()}` : t("forge.create.nameRule")}
        />
        <Input
          label={t("forge.create.description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          variant="outline"
          disabled={busy}
        />
        <Switch
          checked={isPrivate}
          onChange={setIsPrivate}
          label={t("forge.create.private")}
          description={t(isPrivate ? "forge.create.privateDesc" : "forge.create.publicDesc")}
          labelPosition="left"
          disabled={busy}
        />

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>

      {adding && (
        <AddGitAccountDialog kind={null} onClose={() => setAdding(false)}
          onAdded={(a) => { if (a.kind !== "other") setAccountId(a.id); }} />
      )}
    </AppDialog>
  );
}
