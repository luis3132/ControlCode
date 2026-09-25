import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimateSpin, Button, Input, Select, Switch } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";
import { useUiStore } from "@/app/uiStore";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useForgeStore } from "@/features/forge/store";
import { SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { useSyncStore } from "./store";
import type { SyncReport } from "./types";

const DEFAULT_REPO = "controlcode-sync";

function ReportList({ title, items, tone }: { title: string; items: string[]; tone: "ok" | "warn" | "bad" }) {
  if (items.length === 0) return null;
  const color = tone === "bad" ? "text-red-500 dark:text-red-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-white/45";
  return (
    <details className="text-[11.5px]">
      <summary className={`cursor-pointer ${color}`}>{title}</summary>
      <ul className="mt-1 ml-4 list-disc text-gray-500 dark:text-white/45">
        {items.map((it) => <li key={it} className="break-words">{it}</li>)}
      </ul>
    </details>
  );
}

function Report({ report }: { report: SyncReport }) {
  const { t } = useTranslation();
  const quiet = report.changes.length === 0 && report.conflicts.length === 0 && report.failures.length === 0;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <span className="text-[11.5px] text-gray-600 dark:text-gray-300">
        {t("sync.last", { ago: elapsed(report.at * 1000) })}
        {report.pushed && ` · ${t("sync.pushed")}`}
        {report.first && ` · ${t("sync.first")}`}
        {quiet && ` · ${t("sync.nothing")}`}
      </span>
      <ReportList title={t("sync.changes", { count: report.changes.length })} items={report.changes} tone="ok" />
      <ReportList title={t("sync.conflicts", { count: report.conflicts.length })} items={report.conflicts} tone="warn" />
      <ReportList title={t("sync.failures", { count: report.failures.length })} items={report.failures} tone="bad" />
    </div>
  );
}

/**
 * Configuración → Sincronización: las skills y la configuración del usuario en un repo
 * privado de una de sus cuentas de git, al día en todas sus máquinas.
 */
export function SyncSection() {
  const { t } = useTranslation();
  const status = useSyncStore((s) => s.status);
  const running = useSyncStore((s) => s.running);
  const error = useSyncStore((s) => s.error);
  const sessionReport = useSyncStore((s) => s.report);
  const { load, sync, setup, disconnect, setAuto } = useSyncStore.getState();
  const accounts = useForgeStore((s) => s.accounts);
  const loadAccounts = useForgeStore((s) => s.load);
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);
  const usable = useMemo(() => accounts.filter((a) => a.kind !== "other"), [accounts]);
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState(DEFAULT_REPO);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => { load().catch(() => {}); loadAccounts().catch(() => {}); }, [load, loadAccounts]);
  useEffect(() => { if (!accountId && usable[0]) setAccountId(usable[0].id); }, [accountId, usable]);

  const account = accounts.find((a) => a.id === status?.accountId);
  const report = sessionReport ?? status?.last ?? null;

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title={t("sync.title")} description={t("sync.description")}>
        {!status ? null : !status.configured ? (
          usable.length === 0 ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
              <span className="text-[12px] text-gray-600 dark:text-gray-300">{t("sync.needAccount")}</span>
              <Button size="sm" variant="primary" onClick={() => setAccountsOpen(true)}>{t("sync.openAccounts")}</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <Select
                  label={t("sync.account")}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  options={usable.map((a) => ({ value: a.id, label: `@${a.login} · ${a.host}` }))}
                  variant="outline"
                  disabled={running}
                />
                <Input label={t("sync.repoName")} value={name} onChange={(e) => setName(e.target.value)}
                  variant="outline" disabled={running} helperText={t("sync.repoHelper")} />
              </div>
              <div className="flex justify-end">
                <Button variant="primary" disabled={running || !accountId || !name.trim()}
                  onClick={() => setup(accountId, name.trim())} className="flex items-center gap-1.5">
                  {running && <AnimateSpin className="w-3.5 h-3.5" />}
                  {running ? t("sync.connecting") : t("sync.connect")}
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <SettingsRow label={status.repo ?? ""} hint={account ? `@${account.login} · ${account.host}` : undefined}>
              <span className="flex items-center gap-1.5">
                {status.webUrl && (
                  <Button size="sm" variant="outline" onClick={() => openUrl(status.webUrl!).catch(console.error)}
                    className="flex items-center gap-1">
                    <ExternalIcon className="w-3 h-3" />
                    {t("forge.openWeb")}
                  </Button>
                )}
                <Button size="sm" variant="primary" disabled={running} onClick={() => sync()} className="flex items-center gap-1.5">
                  {running && <AnimateSpin className="w-3.5 h-3.5" />}
                  {running ? t("sync.running") : t("sync.now")}
                </Button>
              </span>
            </SettingsRow>
            <SettingsRow label={t("sync.auto")} hint={t("sync.autoHint")}>
              <Switch checked={status.auto} onChange={(v) => setAuto(v)} />
            </SettingsRow>
            {report && <Report report={report} />}
            <div className="flex justify-end">
              <Button size="sm" variant="outline" disabled={running} onClick={() => setConfirmOff(true)}>
                {t("sync.disconnect")}
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </SettingsSection>

      <SettingsSection title={t("sync.whatTitle")}>
        <div className="grid grid-cols-2 gap-3 text-[11.5px] leading-relaxed">
          <div className="px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
            <p className="mb-1 font-semibold text-gray-700 dark:text-gray-200">{t("sync.what.yes")}</p>
            <ul className="ml-4 list-disc text-gray-500 dark:text-white/45">
              <li>{t("sync.what.skills")}</li>
              <li>{t("sync.what.marketplace")}</li>
              <li>{t("sync.what.prelaunch")}</li>
              <li>{t("sync.what.tuis")}</li>
              <li>{t("sync.what.prefs")}</li>
            </ul>
          </div>
          <div className="px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
            <p className="mb-1 font-semibold text-gray-700 dark:text-gray-200">{t("sync.what.no")}</p>
            <ul className="ml-4 list-disc text-gray-500 dark:text-white/45">
              <li>{t("sync.what.secrets")}</li>
              <li>{t("sync.what.env")}</li>
              <li>{t("sync.what.machine")}</li>
              <li>{t("sync.what.history")}</li>
            </ul>
          </div>
        </div>
      </SettingsSection>

      {confirmOff && (
        <AppDialog
          title={t("sync.disconnectTitle")}
          onClose={() => setConfirmOff(false)}
          size="sm"
          closeOnEsc
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmOff(false)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={() => { setConfirmOff(false); disconnect().catch(console.error); }}>
                {t("sync.disconnect")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("sync.disconnectBody", { repo: status?.repo ?? "" })}</p>
        </AppDialog>
      )}
    </div>
  );
}
