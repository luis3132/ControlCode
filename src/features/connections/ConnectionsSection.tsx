import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AddIcon, AnimateSpin, Button, EditIcon, FolderIcon, InfoIcon, Input, MonitorIcon, Switch,
  Tooltip, TrashIcon,
} from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { SettingsSection } from "@/features/settings/SettingsSection";
import { useConnectionsStore } from "./store";
import { terminalCommand, testConnection } from "./ipc";
import {
  describeConnection, parsePort, type ConnectionCheck, type SshConnection, type SshConnectionDraft,
} from "./types";

/** Lo que dijo la última prueba, debajo de la conexión o del formulario. */
function CheckResult({ check }: { check: ConnectionCheck | "running" | null }) {
  const { t } = useTranslation();
  if (!check) return null;
  if (check === "running") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-white/40">
        <AnimateSpin className="w-3 h-3" /> {t("connections.testing")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      <p className={check.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400 break-words"}>
        {check.ok ? t("connections.ok", { ms: check.elapsedMs }) : check.detail}
      </p>
      {check.hint && <p className="text-gray-500 dark:text-white/40">{check.hint}</p>}
    </div>
  );
}

/** Alta y edición usan el mismo formulario; `initial` decide cuál de las dos es. */
function ConnectionForm({ initial, onSave, onCancel }: {
  initial?: SshConnection;
  onSave: (draft: SshConnectionDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [user, setUser] = useState(initial?.user ?? "");
  const [port, setPort] = useState(initial?.port ? String(initial.port) : "");
  const [identityFile, setIdentityFile] = useState(initial?.identityFile ?? "");
  const [remoteDir, setRemoteDir] = useState(initial?.remoteDir ?? "");
  const [agentAccess, setAgentAccess] = useState(initial?.agentAccess ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | "running" | null>(null);

  const parsedPort = parsePort(port);
  const valid = name.trim() && host.trim() && parsedPort !== "invalid";

  const draft = (): SshConnectionDraft => ({
    id: initial?.id,
    name: name.trim(),
    host: host.trim(),
    user: user.trim() || null,
    port: parsedPort === "invalid" ? null : parsedPort,
    identityFile: identityFile.trim() || null,
    remoteDir: remoteDir.trim() || null,
    agentAccess,
  });

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft());
      if (!initial) {
        setName(""); setHost(""); setUser(""); setPort(""); setIdentityFile(""); setRemoteDir("");
        setAgentAccess(true); setCheck(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setCheck("running");
    setError(null);
    try {
      setCheck(await testConnection(draft()));
    } catch (e) {
      setCheck(null);
      setError(String(e));
    }
  };

  const pickKey = async () => {
    const selected = await open({ multiple: false, directory: false, title: t("connections.identityFile") });
    if (typeof selected === "string" && selected) setIdentityFile(selected);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr_8rem_5.5rem] gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("connections.namePlaceholder")} />
        <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder={t("connections.hostPlaceholder")}
          className="font-mono text-xs" />
        <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder={t("connections.userPlaceholder")}
          className="font-mono text-xs" />
        <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric"
          className="font-mono text-xs" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="flex gap-1.5">
          <Input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)}
            placeholder={t("connections.identityPlaceholder")} className="flex-1 font-mono text-xs" />
          <Tooltip content={t("connections.pickKey")} placement="top">
            <button type="button" onClick={pickKey} aria-label={t("connections.pickKey")}
              className="cc-t shrink-0 w-9 grid place-items-center rounded-lg text-gray-400
                hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-white/10">
              <FolderIcon className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>
        <Input value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)}
          placeholder={t("connections.dirPlaceholder")} className="font-mono text-xs" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Switch checked={agentAccess} onChange={setAgentAccess} size="sm"
          label={t("connections.agentAccess")} description={t("connections.agentAccess.desc")} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={!valid || check === "running"}>
            {t("connections.test")}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!valid || saving}>
            {initial ? t("btn.save") : <span className="flex items-center gap-1"><AddIcon className="w-3.5 h-3.5" />{t("connections.add")}</span>}
          </Button>
          {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>{t("btn.cancel")}</Button>}
        </div>
      </div>
      {parsedPort === "invalid" && <p className="text-xs text-red-500">{t("connections.badPort")}</p>}
      <CheckResult check={check} />
      {error && <p className="text-xs text-red-500 break-words">{error}</p>}
    </div>
  );
}

const iconButton = `cc-t w-7 h-7 grid place-items-center rounded-lg text-gray-400
  hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-white/10
  disabled:opacity-40`;

/**
 * Configuración → Conexiones: las otras computadoras a las que se llega por SSH.
 *
 * Cada una sirve para dos cosas: abrir una terminal allá con un click, y —si se la habilita
 * para agentes— que un agente de acá corra comandos y copie archivos allá (`ssh_run`,
 * `ssh_copy`). La conexión la hace el `ssh` del sistema, con la configuración y las claves
 * que la persona ya tiene; la app no guarda contraseñas.
 */
export function ConnectionsSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const connections = useConnectionsStore((s) => s.connections);
  const loaded = useConnectionsStore((s) => s.loaded);
  const load = useConnectionsStore((s) => s.load);
  const save = useConnectionsStore((s) => s.save);
  const remove = useConnectionsStore((s) => s.remove);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ConnectionCheck | "running">>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);

  const runTest = async (c: SshConnection) => {
    setChecks((s) => ({ ...s, [c.id]: "running" }));
    try {
      const result = await testConnection({ ...c });
      setChecks((s) => ({ ...s, [c.id]: result }));
    } catch (e) {
      setChecks((s) => ({ ...s, [c.id]: { ok: false, detail: String(e), hint: null, elapsedMs: 0 } }));
    }
  };

  /** Una tab de terminal conectada, en la carpeta que se está mirando. */
  const openTerminal = async (c: SshConnection) => {
    setError(null);
    try {
      const launch = await terminalCommand(c.id);
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
      tabs.addTab({
        cwd: active?.cwd ?? launch.cwd,
        agent: { id: SHELL_AGENT_ID, label: `SSH · ${c.name}`, command: launch.command, available: true },
        title: `ssh · ${c.name}`,
        titleIsCustom: true,
      });
      useUiStore.getState().setSettingsOpen(false);
      navigate("/workspace");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <SettingsSection title={t("settings.connections")} description={t("settings.connections.desc")}>
      {connections.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {connections.map((c) =>
            editingId === c.id ? (
              <div key={c.id} className="px-4 py-3 rounded-xl border border-blue-300 dark:border-blue-500/40
                bg-blue-50/40 dark:bg-blue-500/5">
                <ConnectionForm
                  initial={c}
                  onSave={async (draft) => { await save(draft); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div key={c.id} className="cc-t group flex flex-col gap-1 px-3 py-2 rounded-lg
                bg-gray-100/70 dark:bg-white/4 hover:bg-gray-100 dark:hover:bg-white/6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {c.name}
                      </span>
                      {c.agentAccess && (
                        <span className="shrink-0 text-[9.5px] px-1.5 rounded
                          bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
                          {t("connections.agentsBadge")}
                        </span>
                      )}
                    </span>
                    <code className="text-[10.5px] font-mono text-gray-400 dark:text-white/35 truncate">
                      {describeConnection(c)}{c.remoteDir ? `  ·  ${c.remoteDir}` : ""}
                    </code>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => runTest(c)} disabled={checks[c.id] === "running"}>
                      {t("connections.test")}
                    </Button>
                    <Tooltip content={t("connections.openTerminal")} placement="left">
                      <button type="button" onClick={() => openTerminal(c)} aria-label={t("connections.openTerminal")}
                        className={iconButton}>
                        <MonitorIcon className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                    <Tooltip content={t("btn.edit")} placement="left">
                      <button type="button" onClick={() => setEditingId(c.id)} aria-label={t("btn.edit")}
                        className={iconButton}>
                        <EditIcon className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                    <Tooltip content={t("btn.delete")} placement="left">
                      <button type="button" onClick={() => remove(c.id).catch((e) => setError(String(e)))}
                        aria-label={t("btn.delete")}
                        className="cc-t w-7 h-7 grid place-items-center rounded-lg text-gray-400
                          hover:text-red-500 hover:bg-red-500/10">
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <CheckResult check={checks[c.id] ?? null} />
              </div>
            )
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-500 break-words">{error}</p>}

      <ConnectionForm onSave={async (draft) => { await save(draft); }} />

      <div className="flex items-start gap-2 mt-4 text-xs text-gray-500 dark:text-gray-400">
        <InfoIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>{t("settings.connections.hint")}</p>
      </div>
    </SettingsSection>
  );
}
