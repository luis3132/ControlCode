import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Button, InfoIcon, Input, Switch, Tooltip, TrashIcon } from "neogestify-ui-components";

import { SettingsSection } from "@/features/settings/SettingsSection";
import * as ipc from "./ipc";
import { formatCountdown, type Pairing, type RemoteConfig, type RemoteDevice, type RemoteStatus } from "./types";

const STATUS_DOT: Record<RemoteStatus["state"], string> = {
  off: "bg-gray-400",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-500",
  error: "bg-red-500",
};

/** El QR de emparejamiento, con su cuenta regresiva. */
function PairingPanel({ pairing, onClose }: { pairing: Pairing; onClose: () => void }) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(pairing.expiresInSecs);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const remaining = pairing.expiresInSecs - (Date.now() - started) / 1000;
      setLeft(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const expired = left <= 0;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 p-4 rounded-xl
      border border-blue-300 dark:border-blue-500/40 bg-blue-50/40 dark:bg-blue-500/5">
      {/* El SVG lo arma el backend (crate `qrcode`) a partir de datos propios: no hay
          nada de afuera adentro. Fondo blanco siempre, para que la cámara lo lea en tema
          oscuro. */}
      <div
        className={`shrink-0 w-[240px] h-[240px] rounded-lg overflow-hidden bg-white ${expired ? "opacity-20" : ""}`}
        dangerouslySetInnerHTML={{ __html: pairing.svg }}
      />
      <div className="flex flex-col gap-2 text-[12px] text-gray-600 dark:text-gray-300">
        <p className="font-semibold text-gray-800 dark:text-gray-100">{t("remote.pair.title")}</p>
        <ol className="list-decimal pl-4 flex flex-col gap-1">
          <li>{t("remote.pair.step1")}</li>
          <li>{t("remote.pair.step2")}</li>
          <li>{t("remote.pair.step3")}</li>
        </ol>
        <p className={expired ? "text-red-500" : "text-gray-400 dark:text-white/35"}>
          {expired ? t("remote.pair.expired") : t("remote.pair.expires", { time: formatCountdown(left) })}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(pairing.code)}>
            {t("remote.pair.copy")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Configuración → Móvil: manejar Control Code desde el teléfono.
 *
 * La app se conecta hacia afuera a un relay que aloja la persona (`relay/` en el repo), y
 * los teléfonos se emparejan escaneando un QR. Todo lo que pasa entre los dos va cifrado
 * de punta a punta: el relay solo lo reenvía.
 */
export function RemoteSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = useCallback(() => {
    ipc.listDevices().then(setDevices).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    ipc.getConfig().then(setConfig).catch((e) => setError(String(e)));
    ipc.getStatus().then(setStatus).catch(console.error);
    refreshDevices();
    const offs = [
      listen<RemoteStatus>("remote-status", (e) => setStatus(e.payload)),
      listen("remote-devices", refreshDevices),
      listen("remote-paired", () => {
        setPairing(null);
        setPaired(true);
        refreshDevices();
      }),
    ];
    return () => {
      offs.forEach((p) => p.then((off) => off()));
      ipc.cancelPairing().catch(() => {});
    };
  }, [refreshDevices]);

  if (!config) return null;

  const update = (patch: Partial<RemoteConfig>) => setConfig({ ...config, ...patch });

  const save = async (next: RemoteConfig = config) => {
    setSaving(true);
    setError(null);
    try {
      await ipc.saveConfig({ ...next, token: next.token?.trim() || null });
      setConfig(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const pair = async () => {
    setError(null);
    setPaired(false);
    try {
      setPairing(await ipc.startPairing());
    } catch (e) {
      setError(String(e));
    }
  };

  const closePairing = () => {
    setPairing(null);
    ipc.cancelPairing().catch(() => {});
  };

  const state = status?.state ?? "off";

  return (
    <SettingsSection title={t("settings.remote")} description={t("settings.remote.desc")}>
      <div className="flex flex-col gap-2">
        <Switch
          checked={config.enabled}
          onChange={(enabled) => save({ ...config, enabled })}
          label={t("remote.enabled")}
          disabled={saving || (!config.enabled && !config.relayUrl.trim())}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input value={config.relayUrl} onChange={(e) => update({ relayUrl: e.target.value })}
            placeholder={t("remote.relayPlaceholder")} className="font-mono text-xs" />
          <Input value={config.token ?? ""} onChange={(e) => update({ token: e.target.value })}
            placeholder={t("remote.tokenPlaceholder")} type="password" className="font-mono text-xs" />
        </div>
        <div className="flex gap-2">
          <Input value={config.name} onChange={(e) => update({ name: e.target.value })}
            placeholder={t("remote.namePlaceholder")} className="flex-1" />
          <Button variant="primary" size="sm" onClick={() => save()} disabled={saving}>
            {t("btn.save")}
          </Button>
        </div>

        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-gray-100/70 dark:bg-white/4 text-[12px]">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[state]}`} />
          <span className="text-gray-700 dark:text-gray-300">{t(`remote.status.${state}`)}</span>
          {status?.error && state !== "connected" && (
            <span className="truncate text-red-500 dark:text-red-400">— {status.error}</span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-white/30">
          {t("remote.devices")}
        </span>
        {!pairing && (
          <Button variant="outline" size="sm" onClick={pair} disabled={state !== "connected"}>
            {t("remote.pair")}
          </Button>
        )}
      </div>

      {pairing && <PairingPanel pairing={pairing} onClose={closePairing} />}
      {paired && <p className="text-[12px] text-emerald-600 dark:text-emerald-400">{t("remote.pair.done")}</p>}

      {devices.length === 0 ? (
        <p className="text-[11.5px] text-gray-400 dark:text-white/30">{t("remote.noDevices")}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {devices.map((d) => (
            <div key={d.id} className="cc-t flex items-center gap-3 px-3 py-2 rounded-lg
              bg-gray-100/70 dark:bg-white/4 hover:bg-gray-100 dark:hover:bg-white/6">
              <span className={`w-2 h-2 rounded-full shrink-0 ${d.online ? "bg-emerald-500" : "bg-gray-400"}`} />
              <div className="flex flex-col gap-px min-w-0 flex-1">
                <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">{d.name}</span>
                <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
                  {[d.platform, d.online ? t("remote.online") : t("remote.offline"),
                    d.hasPush ? t("remote.push") : null].filter(Boolean).join(" · ")}
                </span>
              </div>
              <Tooltip content={t("remote.unpair")} placement="left">
                <button type="button" aria-label={t("remote.unpair")}
                  onClick={() => ipc.removeDevice(d.id).then(refreshDevices).catch((e) => setError(String(e)))}
                  className="cc-t w-7 h-7 grid place-items-center rounded-lg text-gray-400
                    hover:text-red-500 hover:bg-red-500/10">
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-500 break-words">{error}</p>}

      <div className="flex items-start gap-2 mt-4 text-xs text-gray-500 dark:text-gray-400">
        <InfoIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>{t("settings.remote.hint")}</p>
      </div>
    </SettingsSection>
  );
}
