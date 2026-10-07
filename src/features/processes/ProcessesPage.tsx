import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AddIcon, Button, CopyIcon, EmptyState, Input, Switch, Tooltip, TrashIcon } from "neogestify-ui-components";

import { FolderOpenIcon, ProcessIcon, RefreshIcon } from "@/app/icons";
import { agentPaint } from "@/features/browser/agentPaint";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useDocumentVisible } from "@/shared/useDocumentVisible";

import { procsClear, procsRestart, procsStart, procsStop, procsUsage } from "./ipc";
import { ProcessTerminal } from "./ProcessTerminal";
import { useProcessesStore } from "./store";
import { byWorkspace, formatMemory, formatUptime, visibleProcesses, type ProcUsage, type Subprocess } from "./types";

/** Cada cuánto se leen CPU y memoria mientras la sección está abierta. */
const USAGE_MS = 2000;

/** La carpeta del workspace en el que se está parado: la de la tab activa. */
function useCurrentWorkspace(): string | null {
  return useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
}

function folderName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

/** El punto de estado: verde corriendo, gris si terminó bien o lo pararon, rojo si falló. */
function StatusDot({ proc }: { proc: Subprocess }) {
  const color =
    proc.status === "running" ? "bg-emerald-500"
      : proc.status === "exited" && proc.exitCode !== 0 ? "bg-red-500"
        : "bg-gray-400 dark:bg-white/30";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

/** Quién lo lanzó: el agente de una tab (con su color), una tarea de la flota, o la persona. */
function OwnerLabel({ proc }: { proc: Subprocess }) {
  const { t } = useTranslation();
  const tab = useTabsStore((s) => (proc.owner.tabId ? s.tabs.find((x) => x.id === proc.owner.tabId) : undefined));
  if (proc.owner.tabId) {
    return (
      <span className="flex items-center gap-1 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentPaint(proc.owner.tabId).strip}`} />
        <span className="truncate">{tab?.title ?? t("processes.owner.closedTab")}</span>
      </span>
    );
  }
  if (proc.owner.taskId) return <span className="truncate">{t("processes.owner.fleet")}</span>;
  return <span className="truncate">{t("processes.owner.you")}</span>;
}

function ProcessRow({ proc, usage, selected, now, onSelect }: {
  proc: Subprocess;
  usage: ProcUsage | undefined;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const ended = proc.status !== "running";
  return (
    <Button variant="custom"
      onClick={onSelect}
      className={`cc-t flex flex-col gap-1 w-full px-3 py-2 rounded-lg text-left
        ${selected ? "bg-blue-500/12 dark:bg-blue-400/13" : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}
    >
      <span className="flex items-center gap-2 w-full min-w-0">
        <StatusDot proc={proc} />
        <span className={`flex-1 min-w-0 truncate text-[12.5px] font-semibold
          ${ended ? "text-gray-500 dark:text-white/45" : "text-gray-800 dark:text-gray-100"}`}>
          {proc.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-gray-400 dark:text-white/30">{proc.id}</span>
      </span>
      <span className="w-full truncate font-mono text-[10.5px] text-gray-500 dark:text-white/40">{proc.command}</span>
      <span className="flex items-center gap-2 w-full text-[10.5px] text-gray-400 dark:text-white/35">
        <OwnerLabel proc={proc} />
        <span className="flex-1" />
        {ended ? (
          <span className="shrink-0">
            {proc.status === "stopped" ? t("processes.status.stopped") : t("processes.status.exited", { code: proc.exitCode ?? 0 })}
          </span>
        ) : (
          <>
            {usage && <span className="shrink-0 tabular-nums">{Math.round(usage.cpu)}% · {formatMemory(usage.memory)}</span>}
            <span className="shrink-0 tabular-nums">{formatUptime(now - proc.startedAt)}</span>
          </>
        )}
      </span>
    </Button>
  );
}

function ToolbarButton({ label, onClick, disabled, danger, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button variant="custom"
      onClick={onClick}
      disabled={disabled}
      className={`cc-t flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[11.5px] font-medium shrink-0
        border border-gray-200 dark:border-white/10 disabled:opacity-40
        ${danger
          ? "text-red-600 dark:text-red-400 hover:bg-red-500/10"
          : "text-gray-700 dark:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-white/8"}`}
    >
      {children}
      {label}
    </Button>
  );
}

function NewProcessDialog({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [command, setCommand] = useState("");
  const [folder, setFolder] = useState(cwd);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = () => {
    if (!command.trim() || busy) return;
    setBusy(true);
    setError("");
    procsStart(command.trim(), folder.trim() || cwd, name.trim() || null)
      .then(onClose, (e) => {
        setError(String(e));
        setBusy(false);
      });
  };

  return (
    <AppDialog
      title={t("processes.new.title")}
      icon={<ProcessIcon className="w-4 h-4" />}
      size="md"
      closeOnEsc
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button onClick={start} disabled={!command.trim() || busy}>{t("processes.new.start")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label={t("processes.new.command")}
          placeholder="npm run dev"
          value={command}
          autoFocus
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          className="font-mono"
        />
        <Input label={t("processes.new.folder")} value={folder} onChange={(e) => setFolder(e.target.value)} className="font-mono" />
        <Input label={t("processes.new.name")} placeholder={t("processes.new.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        {error && <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </AppDialog>
  );
}

/**
 * Subprocesos: los servidores, watchers y compilaciones que corren los agentes (o vos) a
 * través de Control Code. Por defecto los del workspace actual; con «Mostrar todos», los de
 * todos, agrupados. De cada uno: su terminal en vivo (se le puede escribir), CPU, memoria,
 * quién lo lanzó, y pararlo o reiniciarlo.
 */
export function ProcessesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const procs = useProcessesStore((s) => s.procs);
  const showAll = useProcessesStore((s) => s.showAll);
  const setShowAll = useProcessesStore((s) => s.setShowAll);
  const workspace = useCurrentWorkspace();
  const docVisible = useDocumentVisible();

  const shown = useMemo(() => visibleProcesses(procs, workspace, showAll), [procs, workspace, showAll]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find((p) => p.id === selectedId) ?? shown[0] ?? null;
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // CPU y memoria, y el reloj de "hace cuánto", solo mientras la sección está a la vista.
  const [usage, setUsage] = useState<Map<string, ProcUsage>>(new Map());
  const [now, setNow] = useState(Date.now());
  const anyRunning = procs.some((p) => p.status === "running");
  useEffect(() => {
    if (!docVisible || !anyRunning) return;
    let alive = true;
    const tick = () => {
      setNow(Date.now());
      procsUsage()
        .then((list) => { if (alive) setUsage(new Map(list.map((u) => [u.id, u]))); })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, USAGE_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [docVisible, anyRunning]);

  const act = (id: string, op: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    op().catch((e) => setError(String(e))).finally(() => setBusy(null));
  };

  const goToOwner = (proc: Subprocess) => {
    if (!proc.owner.tabId) return;
    useTabsStore.getState().activateTab(proc.owner.tabId);
    useViewTabsStore.getState().showTerminal();
    navigate("/workspace");
  };

  const finished = shown.filter((p) => p.status !== "running").length;
  const groups = showAll ? byWorkspace(shown) : [[workspace ?? "", shown] as [string, Subprocess[]]];

  return (
    // `@container`: la sección vive en un modal cuyo ancho depende de la ventana, así que
    // se acomoda a lo que mide ella y no a la pantalla.
    <div className="@container flex flex-col h-full min-h-0">
      {/* ══ franja ═══════════════════════════════════════════════════ */}
      {/* Si no entra en un renglón (un modal angosto), los controles bajan a otro: nunca
          quedan debajo de la ✕ del marco, que va en la esquina (de ahí el `pr-14`). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 min-h-[54px] py-2 shrink-0 pl-4 pr-14 min-w-0 border-b border-gray-200 dark:border-white/8">
        <ProcessIcon className="w-[15px] h-[15px] shrink-0 text-emerald-500 dark:text-emerald-400" />
        <span className="shrink-0 text-[13.5px] font-bold text-gray-900 dark:text-white">{t("processes.title")}</span>
        <span className="hidden @xl:inline min-w-0 truncate text-[11.5px] text-gray-400 dark:text-white/35">
          {showAll ? t("processes.scope.all") : workspace ? folderName(workspace) : t("processes.scope.none")}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 shrink-0">
        <div className="shrink-0 whitespace-nowrap">
          <Switch checked={showAll} onChange={setShowAll} label={t("processes.showAll")} labelPosition="left" />
        </div>
        <Tooltip content={t("processes.clearFinished")} placement="bottom">
          <Button variant="icon"
            onClick={() => procsClear(null).catch(console.error)}
            disabled={finished === 0}
            aria-label={t("processes.clearFinished")}
            className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0 text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-40 p-0"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>
        <Button size="sm" onClick={() => setNewOpen(true)} disabled={!workspace}>
          <AddIcon className="w-3.5 h-3.5" />
          {t("processes.new.button")}
        </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 shrink-0 px-4 py-2 text-[11.5px]
          border-b border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/8 text-red-600 dark:text-red-400">
          <span className="flex-1 min-w-0 break-words">{error}</span>
          <Button variant="custom" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100">{t("btn.close")}</Button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <EmptyState
            icon={<ProcessIcon className="w-8 h-8" />}
            title={t("processes.empty.title")}
            description={t(showAll ? "processes.empty.descAll" : "processes.empty.desc")}
          />
        </div>
      ) : (
        <div className="flex flex-col @2xl:flex-row flex-1 min-h-0">
          {/* ══ lista ═════════════════════════════════════════════════ */}
          {/* Angosta, va arriba con un tope de alto; ancha, a la izquierda. */}
          <div className="shrink-0 max-h-[40%] @2xl:max-h-none @2xl:w-80 overflow-y-auto cc-scroll p-2
            border-b @2xl:border-b-0 @2xl:border-r border-gray-200 dark:border-white/8">
            {groups.map(([ws, list]) => (
              <div key={ws} className="mb-2">
                {showAll && (
                  <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 dark:text-white/30 truncate">
                    {folderName(ws)}
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  {list.map((proc) => (
                    <ProcessRow
                      key={proc.id}
                      proc={proc}
                      usage={usage.get(proc.id)}
                      selected={proc.id === selected?.id}
                      now={now}
                      onSelect={() => setSelectedId(proc.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ══ detalle ═══════════════════════════════════════════════ */}
          {selected && (
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <div className="flex items-center gap-2 h-11 shrink-0 px-3 border-b border-gray-200 dark:border-white/8 overflow-x-auto cc-scroll-x">
                <StatusDot proc={selected} />
                <span className="truncate font-mono text-[11.5px] text-gray-600 dark:text-white/60" title={selected.cwd}>
                  {selected.command}
                </span>
                <div className="flex-1" />
                {selected.status === "running" ? (
                  <>
                    <ToolbarButton label={t("processes.stop")} disabled={busy === selected.id}
                      onClick={() => act(selected.id, () => procsStop(selected.id, false))}>
                      <span className="w-2 h-2 rounded-[2px] bg-current" />
                    </ToolbarButton>
                    <ToolbarButton label={t("processes.kill")} danger disabled={busy === selected.id}
                      onClick={() => act(selected.id, () => procsStop(selected.id, true))}>
                      <TrashIcon className="w-3 h-3" />
                    </ToolbarButton>
                  </>
                ) : (
                  <ToolbarButton label={t("processes.forget")} onClick={() => act(selected.id, () => procsClear(selected.id))}>
                    <TrashIcon className="w-3 h-3" />
                  </ToolbarButton>
                )}
                <ToolbarButton label={t("processes.restart")} disabled={busy === selected.id}
                  onClick={() => act(selected.id, () => procsRestart(selected.id))}>
                  <RefreshIcon className="w-3 h-3" />
                </ToolbarButton>
                <Tooltip content={t("processes.copyCommand")} placement="bottom">
                  <Button variant="icon" aria-label={t("processes.copyCommand")}
                    onClick={() => navigator.clipboard.writeText(selected.command).catch(console.error)}
                    className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0 text-gray-400 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10 p-0">
                    <CopyIcon className="w-3.5 h-3.5" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("processes.openFolder")} placement="bottom">
                  <Button variant="icon" aria-label={t("processes.openFolder")}
                    onClick={() => revealItemInDir(selected.cwd).catch((e) => setError(String(e)))}
                    className="cc-t flex items-center justify-center w-7 h-7 rounded-lg shrink-0 text-gray-400 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10 p-0">
                    <FolderOpenIcon className="w-3.5 h-3.5" />
                  </Button>
                </Tooltip>
                {selected.owner.tabId && (
                  <ToolbarButton label={t("processes.goToAgent")} onClick={() => goToOwner(selected)}>
                    <span className={`w-2 h-2 rounded-full ${agentPaint(selected.owner.tabId).strip}`} />
                  </ToolbarButton>
                )}
              </div>
              <div className="flex-1 min-h-0 p-2 bg-gray-50 dark:bg-[#0d1117]">
                {/* La key por PTY: reiniciar es otro proceso y otra salida. */}
                <ProcessTerminal key={selected.ptyId} ptyId={selected.ptyId} running={selected.status === "running"} />
              </div>
            </div>
          )}
        </div>
      )}

      {newOpen && workspace && <NewProcessDialog cwd={workspace} onClose={() => setNewOpen(false)} />}
    </div>
  );
}
