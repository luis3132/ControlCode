import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimateSpin, Button, CopyIcon, Input, SegmentedControl, Select } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";
import { AppDialog } from "@/shared/ui/AppDialog";

import { FORGE_KINDS, ForgeIcon, TOKEN_SCOPES, forgeLabel, tokenPageUrl } from "./forgeMeta";
import { forgeAddToken, forgeDeviceCancel, forgeDevicePoll, forgeDeviceStart, forgeOauthAvailable } from "./ipc";
import { useForgeStore } from "./store";
import type { DeviceStart, ForgeKind, GitAccount } from "./types";

type Mode = "browser" | "token";

/**
 * Iniciar sesión en un host git: con el navegador (código de dispositivo, como VS Code) o
 * pegando un token.
 *
 * El navegador solo aparece donde la app tiene una aplicación OAuth registrada (github.com
 * y gitlab.com). Un GitLab propio, un GitHub Enterprise, Gitea o un host cualquiera van
 * con token: cada uno tendría su propia aplicación, que la app no puede tener registrada.
 *
 * `host` fijo cuando se abre desde un repo ("iniciá sesión en gitlab.empresa.com"): ahí no
 * tiene sentido dejar cambiarlo. `kind` nulo cuando no se sabe qué es ese host (un GitHub
 * Enterprise no tiene nada en el nombre que lo delate): entonces se pregunta.
 */
export function AddGitAccountDialog({ kind: initialKind, host: fixedHost, onClose, onAdded }: {
  kind: ForgeKind | null;
  host?: string;
  onClose: () => void;
  onAdded?: (account: GitAccount) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ForgeKind>(initialKind ?? "github");
  const kinds = useForgeStore((s) => s.kinds);
  const load = useForgeStore((s) => s.load);
  const info = kinds.find((k) => k.kind === kind);
  const [host, setHost] = useState(fixedHost ?? info?.defaultHost ?? "");
  const [oauth, setOauth] = useState(false);
  const [mode, setMode] = useState<Mode>("token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flowRef = useRef<string | null>(null);

  useEffect(() => { if (kinds.length === 0) load().catch(console.error); }, [kinds.length, load]);
  // Cambiar de tipo propone su host por defecto (el de un genérico queda vacío).
  const defaultHost = info?.defaultHost ?? "";
  useEffect(() => {
    if (!fixedHost) setHost(defaultHost);
  }, [defaultHost, fixedHost]);

  // Si el host escrito tiene navegador, se ofrece primero: es el camino sin copiar tokens.
  useEffect(() => {
    let alive = true;
    const h = host.trim();
    if (!h || kind === "other") { setOauth(false); setMode("token"); return; }
    forgeOauthAvailable(kind, h).then((ok) => {
      if (!alive) return;
      setOauth(ok);
      setMode(ok ? "browser" : "token");
    }).catch(() => alive && setOauth(false));
    return () => { alive = false; };
  }, [kind, host]);

  // Cerrar a mitad del login no deja un flujo esperando en el backend.
  useEffect(() => () => {
    if (flowRef.current) forgeDeviceCancel(flowRef.current).catch(() => {});
  }, []);

  const finish = async (account: GitAccount) => {
    flowRef.current = null;
    await load();
    onAdded?.(account);
    onClose();
  };

  const startBrowser = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await forgeDeviceStart(kind, host.trim());
      setDevice(d);
      flowRef.current = d.flowId;
      await navigator.clipboard.writeText(d.userCode).then(() => setCopied(true)).catch(() => {});
      await openUrl(d.verificationUriComplete ?? d.verificationUri).catch(console.error);
      poll(d.flowId, d.interval);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const poll = (flowId: string, interval: number) => {
    window.setTimeout(async () => {
      if (flowRef.current !== flowId) return;
      try {
        const r = await forgeDevicePoll(flowId);
        if (r.status === "pending") poll(flowId, r.interval);
        else if (r.status === "done") await finish(r.account);
        else {
          flowRef.current = null;
          setDevice(null);
          setBusy(false);
          setError(t(r.status === "expired" ? "forge.add.expired" : "forge.add.denied"));
        }
      } catch (e) {
        flowRef.current = null;
        setDevice(null);
        setBusy(false);
        setError(String(e));
      }
    }, interval * 1000);
  };

  const addToken = async () => {
    setBusy(true);
    setError("");
    try {
      await finish(await forgeAddToken(kind, host.trim(), token, kind === "other" ? username : null));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const label = forgeLabel(kind, t);
  const tokenUrl = host.trim() ? tokenPageUrl(kind, host.trim()) : null;
  const canToken = !!host.trim() && !!token.trim() && (kind !== "other" || !!username.trim());

  return (
    <AppDialog
      title={t("forge.add.title", { provider: label })}
      icon={<ForgeIcon kind={kind} className="w-[15px] h-[15px] shrink-0 text-gray-600 dark:text-gray-300" />}
      onClose={onClose}
      size="sm"
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          {mode === "token" && (
            <Button variant="primary" disabled={busy || !canToken} onClick={addToken}>
              {busy ? t("forge.add.checking") : t("forge.add.save")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {initialKind === null && (
          <Select
            label={t("forge.add.kind")}
            value={kind}
            onChange={(e) => { setKind(e.target.value as ForgeKind); setError(""); }}
            options={FORGE_KINDS.map((k) => ({ value: k, label: forgeLabel(k, t) }))}
            variant="outline"
            disabled={busy || !!device}
          />
        )}
        <Input
          label={t("forge.add.host")}
          value={host}
          onChange={(e) => { setHost(e.target.value); setError(""); }}
          placeholder={info?.defaultHost ?? "git.empresa.com"}
          variant="outline"
          disabled={!!fixedHost || busy}
          helperText={kind === "other" ? t("forge.add.hostOther") : t("forge.add.hostHelper")}
        />

        {oauth && !device && (
          <SegmentedControl
            size="sm"
            aria-label={t("forge.add.method")}
            value={mode}
            onChange={(v) => { setMode(v as Mode); setError(""); }}
            options={[
              { value: "browser", label: t("forge.add.browser") },
              { value: "token", label: t("forge.add.token") },
            ]}
          />
        )}

        {mode === "browser" && (
          device ? (
            <div className="flex flex-col items-center gap-2.5 py-2 text-center">
              <p className="text-[11.5px] text-gray-500 dark:text-white/50">
                {t("forge.add.enterCode", { host: host.trim() })}
              </p>
              <button
                onClick={() => navigator.clipboard.writeText(device.userCode).then(() => setCopied(true)).catch(console.error)}
                title={t("forge.add.copyCode")}
                className="cc-t flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-2xl font-bold tracking-[0.2em]
                  bg-gray-100 dark:bg-white/6 text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-white/10"
              >
                {device.userCode}
                <CopyIcon className="w-4 h-4 opacity-50" />
              </button>
              <span className="text-[10.5px] text-gray-400 dark:text-white/35">
                {copied ? t("forge.add.copied") : t("forge.add.copyCode")}
              </span>
              <Button size="sm" variant="outline"
                onClick={() => openUrl(device.verificationUriComplete ?? device.verificationUri).catch(console.error)}
                className="flex items-center gap-1.5">
                <ExternalIcon className="w-3 h-3" />
                {t("forge.add.openAgain", { host: host.trim() })}
              </Button>
              <span className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/45">
                <AnimateSpin className="w-3 h-3" />
                {t("forge.add.waiting")}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[11.5px] leading-relaxed text-gray-500 dark:text-white/50">
                {t("forge.add.browserHelp", { host: host.trim() })}
              </p>
              <Button variant="primary" disabled={busy || !host.trim()} onClick={startBrowser}>
                {t("forge.add.continueBrowser", { host: host.trim() })}
              </Button>
            </div>
          )
        )}

        {mode === "token" && (
          <>
            {kind === "other" && (
              <Input
                label={t("forge.add.username")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                variant="outline"
                disabled={busy}
                helperText={t("forge.add.usernameHelper")}
              />
            )}
            <Input
              label={kind === "other" ? t("forge.add.password") : t("forge.add.tokenLabel")}
              type="password"
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && canToken && !busy && addToken()}
              variant="outline"
              disabled={busy}
              autoFocus={!oauth}
              helperText={TOKEN_SCOPES[kind] ? t("forge.add.scopes", { scopes: TOKEN_SCOPES[kind] }) : undefined}
            />
            {tokenUrl && (
              <button
                onClick={() => openUrl(tokenUrl).catch(console.error)}
                className="self-start flex items-center gap-1 text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline"
              >
                <ExternalIcon className="w-3 h-3" />
                {t("forge.add.createToken", { host: host.trim() })}
              </button>
            )}
          </>
        )}

        <p className="text-[10.5px] leading-relaxed text-gray-400 dark:text-white/35">
          {t("forge.add.isolated")}
        </p>

        {error && <p className="text-[11.5px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>
    </AppDialog>
  );
}
