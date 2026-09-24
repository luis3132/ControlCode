import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimateSpin, Badge, Button, FolderIcon, Input, SearchIcon, Select, Skeleton } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { homeDir } from "@/shared/ipc/window";

import { AddGitAccountDialog } from "./AddGitAccountDialog";
import { cloneDirName } from "./cloneName";
import { forgeClone, forgeRepos } from "./ipc";
import { useForgeStore } from "./store";
import { forgeErrorOf, type ForgeRepo } from "./types";

const URL_SOURCE = "__url__";
const LAST_PARENT_KEY = "cc.clone.parent";

function readLastParent(): string | null {
  try { return localStorage.getItem(LAST_PARENT_KEY); } catch { return null; }
}

function saveLastParent(dir: string) {
  try { localStorage.setItem(LAST_PARENT_KEY, dir); } catch { /* sin storage: se vuelve a elegir */ }
}

/**
 * Clonar un repo para abrirlo como workspace: elegido de la lista de una cuenta de git, o
 * pegando su URL. Clona con esa cuenta, así un repo privado no pide nada más.
 */
export function CloneRepoDialog({ onClose, onCloned }: {
  onClose: () => void;
  onCloned: (path: string) => void;
}) {
  const { t } = useTranslation();
  const accounts = useForgeStore((s) => s.accounts);
  const loaded = useForgeStore((s) => s.loaded);
  const load = useForgeStore((s) => s.load);
  const apiAccounts = useMemo(() => accounts.filter((a) => a.kind !== "other"), [accounts]);
  const [source, setSource] = useState<string>("");
  const [repos, setRepos] = useState<ForgeRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ForgeRepo | null>(null);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);
  useEffect(() => {
    const last = readLastParent();
    if (last) setParent(last);
    else homeDir().then((home) => home && setParent(home)).catch(() => {});
  }, []);

  // Arranca en la primera cuenta con API; sin ninguna, en "pegar una URL".
  useEffect(() => {
    if (source) return;
    if (!loaded) return;
    setSource(apiAccounts[0]?.id ?? URL_SOURCE);
  }, [source, loaded, apiAccounts]);

  useEffect(() => {
    if (!source || source === URL_SOURCE) { setRepos(null); return; }
    let alive = true;
    setRepos(null);
    setPicked(null);
    setError("");
    forgeRepos(source)
      .then((r) => alive && setRepos(r))
      .catch((e) => { if (alive) { setRepos([]); setError(forgeErrorOf(e).message); } });
    return () => { alive = false; };
  }, [source]);

  const cloneUrl = source === URL_SOURCE ? url.trim() : picked?.cloneUrl ?? "";

  // El nombre de la carpeta sigue al repo elegido hasta que el usuario lo edita.
  useEffect(() => {
    if (!nameTouched) setName(cloneDirName(cloneUrl) ?? "");
  }, [cloneUrl, nameTouched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = repos ?? [];
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)) : list;
  }, [repos, query]);

  const browse = async () => {
    const dir = await open({ directory: true, multiple: false, title: t("forge.clone.parent") });
    if (typeof dir === "string" && dir) setParent(dir);
  };

  const clone = async () => {
    setBusy(true);
    setError("");
    try {
      const path = await forgeClone(cloneUrl, parent.trim(), name.trim() || null,
        source === URL_SOURCE ? null : source);
      saveLastParent(parent.trim());
      onCloned(path);
    } catch (e) {
      setError(forgeErrorOf(e).message);
      setBusy(false);
    }
  };

  const ready = !!cloneUrl && !!parent.trim() && !!name.trim();

  return (
    <AppDialog
      title={t("forge.clone.title")}
      onClose={onClose}
      size="lg"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={clone} className="flex items-center gap-1.5">
            {busy && <AnimateSpin className="w-3.5 h-3.5" />}
            {busy ? t("forge.clone.cloning") : t("forge.clone.action")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Select
              label={t("forge.clone.from")}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              options={[
                ...apiAccounts.map((a) => ({ value: a.id, label: `@${a.login} · ${a.host}` })),
                { value: URL_SOURCE, label: t("forge.clone.byUrl") },
              ]}
              variant="outline"
              disabled={busy}
            />
          </div>
          <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}>{t("forge.add.action")}</Button>
        </div>

        {source === URL_SOURCE ? (
          <Input
            label={t("forge.clone.url")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            variant="outline"
            disabled={busy}
            helperText={t("forge.clone.urlHelper")}
            autoFocus
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("forge.clone.search")}
              variant="outline"
              icon={<SearchIcon className="w-3.5 h-3.5" />}
              clearable
              disabled={busy}
            />
            <div className="h-64 cc-scroll rounded-lg border border-gray-200 dark:border-white/8">
              {repos === null ? (
                <div className="flex flex-col gap-2 p-3">
                  {[70, 55, 80, 60, 75].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
                </div>
              ) : filtered.length === 0 ? (
                <p className="p-4 text-center text-[11.5px] text-gray-400 dark:text-white/30">{t("forge.clone.none")}</p>
              ) : filtered.map((r) => (
                <button
                  key={r.fullName}
                  onClick={() => setPicked(r)}
                  className={`flex flex-col gap-0.5 w-full px-3 py-1.5 text-left
                    ${picked?.fullName === r.fullName
                      ? "bg-blue-500/12 dark:bg-blue-400/13"
                      : "hover:bg-gray-100 dark:hover:bg-white/4"}`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate text-[12px] font-medium text-gray-800 dark:text-gray-100">{r.fullName}</span>
                    {r.private && <Badge variant="neutral" size="sm">{t("forge.clone.private")}</Badge>}
                    {r.archived && <Badge variant="warning" size="sm">{t("forge.clone.archived")}</Badge>}
                    {r.fork && <Badge variant="outline" size="sm">fork</Badge>}
                  </span>
                  {r.description && (
                    <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">{r.description}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Input
            label={t("forge.clone.parent")}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            variant="outline"
            disabled={busy}
          />
          <Button variant="outline" disabled={busy} onClick={browse} className="flex items-center gap-1.5">
            <FolderIcon className="w-3.5 h-3.5" />
            {t("btn.browse")}
          </Button>
        </div>
        <Input
          label={t("forge.clone.name")}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
          variant="outline"
          disabled={busy}
        />

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>

      {adding && (
        <AddGitAccountDialog kind={null} onClose={() => setAdding(false)}
          onAdded={(a) => { if (a.kind !== "other") setSource(a.id); }} />
      )}
    </AppDialog>
  );
}
