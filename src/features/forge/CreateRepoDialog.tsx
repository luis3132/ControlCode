import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimateSpin, Button, CheckCircleIcon, CheckIcon, Input, Select, Switch, useToast } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";

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
  const { toast } = useToast();
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
  // En qué va (ver `forge_create_repo`): sin esto el diálogo decía "Creando…" durante toda
  // la subida, con el repo ya creado y sin forma de saberlo.
  const [step, setStep] = useState<CreateStep | null>(null);
  // El repo, en cuanto existe en la nube: desde ahí ya no se puede "volver a crear".
  const [created, setCreated] = useState<ForgeRepo | null>(null);
  const createdRef = useRef<ForgeRepo | null>(null);
  const [done, setDone] = useState(false);

  // Desde que se abre, para no perder el primer paso si llega antes que el listener.
  useEffect(() => {
    const unlisten = listen<{ cwd: string; step: CreateStep; repo: ForgeRepo | null }>("forge-create-step", (e) => {
      if (e.payload.cwd !== cwd) return;
      setStep(e.payload.step);
      if (e.payload.repo) {
        createdRef.current = e.payload.repo;
        setCreated(e.payload.repo);
      }
    });
    return () => { unlisten.then((stop) => stop()).catch(() => {}); };
  }, [cwd]);

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
    setStep(null);
    try {
      const repo = await forgeCreateRepo({
        cwd,
        accountId,
        owner: owners?.find((o) => o.login === owner) ?? null,
        name: name.trim(),
        description: description.trim() || null,
        private: isPrivate,
      });
      // Salió todo bien: se avisa con un toast y el diálogo se cierra solo. Si ya se había
      // cerrado (la subida siguió en segundo plano), el toast es el único aviso, y alcanza.
      toast({
        title: t("forge.create.doneTitle"),
        description: t("forge.create.doneToast", { repo: repo.fullName }),
        variant: "success",
        duration: 6000,
        action: { label: t("forge.openWeb"), onClick: () => openUrl(repo.webUrl).catch(console.error) },
      });
      onCreated(repo);
    } catch (e) {
      setError(forgeErrorOf(e).message);
      // Si ya se había creado, falló la subida: se termina acá (se reintenta desde Cambios),
      // no se vuelve al formulario, que crearía otro.
      if (createdRef.current) setDone(true);
    } finally {
      setBusy(false);
    }
  };

  // Creado pero sin subir: queda abierto, porque hay algo que hacer (reintentar desde
  // Cambios). Lo que salió bien no pasa por acá: se cierra solo.
  if (done && created) {
    return (
      <AppDialog
        title={t("forge.create.pushFailedTitle")}
        onClose={() => onCreated(created)}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => openUrl(created.webUrl).catch(console.error)}
              className="flex items-center gap-1.5">
              <ExternalIcon className="w-3 h-3" />
              {t("forge.openWeb")}
            </Button>
            <Button variant="primary" onClick={() => onCreated(created)}>{t("forge.create.finish")}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <CheckCircleIcon className="w-5 h-5 shrink-0 text-amber-500" />
            <div className="flex flex-col gap-1 min-w-0">
              <span className="font-mono text-[13px] text-gray-900 dark:text-white break-all">{created.fullName}</span>
              <span className="text-[12px] text-gray-500 dark:text-white/50">
                {t("forge.create.pushFailedBody")}
              </span>
            </div>
          </div>
          {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
        </div>
      </AppDialog>
    );
  }

  return (
    <AppDialog
      title={t("forge.create.title")}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <>
          {/* Ya creado y subiendo: se puede cerrar, la subida sigue sola. */}
          {busy && created ? (
            <Button variant="outline" onClick={() => onCreated(created)}>{t("forge.create.background")}</Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          )}
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

        {busy && <Steps current={step} repo={created} />}

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>

      {adding && (
        <AddGitAccountDialog kind={null} onClose={() => setAdding(false)}
          onAdded={(a) => { if (a.kind !== "other") setAccountId(a.id); }} />
      )}
    </AppDialog>
  );
}

type CreateStep = "local" | "remote" | "push";
const STEPS: CreateStep[] = ["local", "remote", "push"];

/** Los tres pasos, con el que está en curso girando y los anteriores tildados. */
function Steps({ current, repo }: { current: CreateStep | null; repo: ForgeRepo | null }) {
  const { t } = useTranslation();
  const at = current ? STEPS.indexOf(current) : -1;
  return (
    <ol className="flex flex-col gap-1.5 p-3 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/8">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2 text-[12px]">
          <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
            {i < at ? <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />
              : i === at ? <AnimateSpin className="w-3 h-3 text-blue-500" />
              : <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-white/20" />}
          </span>
          <span className={i <= at ? "text-gray-800 dark:text-gray-100" : "text-gray-400 dark:text-white/35"}>
            {t(`forge.create.step.${s}`)}
          </span>
          {s === "push" && repo && (
            <span className="ml-auto truncate font-mono text-[11px] text-gray-500 dark:text-white/45">{repo.fullName}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
