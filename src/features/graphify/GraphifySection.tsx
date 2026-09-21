import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AnimateSpin, Button, CheckCircleIcon, FolderIcon, Input, InfoIcon,
} from "neogestify-ui-components";

import { SettingsSection } from "@/features/settings/SettingsSection";
import { useTabsStore } from "@/features/tabs/store";

import { CommandCatalog } from "./CommandCatalog";
import {
  graphifyInstallCommand, graphifyPackageCommand, graphifyPlan, graphifyRunStep, graphifySaveSteps,
  graphifyStatus,
  type GraphifyPlan, type GraphifyRun, type GraphifyScope, type GraphifyStatus, type GraphifyTarget,
} from "./ipc";
import { RequirementsBlock } from "./RequirementsBlock";
import { orderedTargets, skillState, targetKey } from "./skills";

/** Las tres cosas que se hacen acá, en el orden en que se hacen. */
type View = "requirements" | "install" | "commands";

/** Lo que se ve de un paso mientras corre y cuando terminó. */
interface StepRun {
  running: boolean;
  result: GraphifyRun | null;
}

/** El bloque de salida de un paso: monoespaciado, con scroll y el final a la vista. */
function Output({ run }: { run: GraphifyRun }) {
  return (
    <pre
      className={`max-h-48 overflow-auto cc-scroll whitespace-pre-wrap break-all rounded-lg px-3 py-2
        font-mono text-[10.5px] leading-relaxed
        ${run.ok
          ? "bg-gray-100/70 dark:bg-white/4 text-gray-600 dark:text-gray-300"
          : "bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300"}`}
      // El final es lo que importa: ahí está el error, o el "installed" del cierre.
      ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
    >
      {run.output || " "}
    </pre>
  );
}

/** Un paso: su comando editable, el botón de ejecutar y lo que imprimió. */
function Step({ title, hint, command, onCommand, onRun, run, disabled, children }: {
  title: string;
  hint?: string;
  command: string;
  onCommand: (value: string) => void;
  onRun: () => void;
  run: StepRun;
  disabled?: boolean;
  /** Controles propios del paso, entre la explicación y el comando. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">{title}</span>
        {hint && (
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">{hint}</p>
        )}
      </div>
      {children}
      <div className="flex items-center gap-2">
        <Input
          value={command}
          onChange={(e) => onCommand(e.target.value)}
          variant="minimal"
          size="sm"
          className="flex-1 !font-mono !text-[11px]"
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || run.running || !command.trim()}
          onClick={onRun}
          leftIcon={run.running ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
        >
          {t("settings.graphify.run")}
        </Button>
      </div>
      {run.result && <Output run={run.result} />}
    </div>
  );
}

/** Una fila de destino: dónde cae la skill y qué hay ahí ahora. */
function TargetRow({ target, selected, state, onSelect }: {
  target: GraphifyTarget;
  selected: boolean;
  state: ReturnType<typeof skillState>;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const badge = {
    missing: null,
    current: { text: t("settings.graphify.skill.current"), tone: "text-emerald-600 dark:text-emerald-400" },
    stale: { text: t("settings.graphify.skill.stale"), tone: "text-amber-600 dark:text-amber-400" },
    unknown: { text: t("settings.graphify.skill.unknown"), tone: "text-gray-400 dark:text-white/35" },
  }[state];

  return (
    <button
      onClick={onSelect}
      className={`cc-t flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-left
        ${selected
          ? "bg-blue-500/12 dark:bg-blue-400/13"
          : "bg-gray-100/70 dark:bg-white/4 hover:bg-gray-100 dark:hover:bg-white/6"}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0
        ${selected ? "bg-blue-500" : "bg-gray-300 dark:bg-white/20"}`} />
      <span className="flex flex-col gap-px min-w-0 flex-1">
        <span className="truncate text-[12px] text-gray-800 dark:text-gray-100">{target.label}</span>
        <span className="truncate font-mono text-[10px] text-gray-400 dark:text-white/35">
          {target.path}
        </span>
      </span>
      {badge && (
        <span className={`shrink-0 text-[10px] ${badge.tone}`}>
          {target.installedVersion ? `${badge.text} · ${target.installedVersion}` : badge.text}
        </span>
      )}
    </button>
  );
}

/**
 * Instalar graphify desde Configuración, paso a paso y sin que nada corra solo.
 *
 * [graphify](https://github.com/Graphify-Labs/graphify) mapea el proyecto —código, docs,
 * PDFs, imágenes— a un grafo que el agente consulta en vez de leer archivo por archivo.
 * Se instala en dos pasos, y los dos son comandos de shell que acá se ven, se editan y se
 * ejecutan de a uno.
 *
 * El paso 2 es el que no puede ser un comando fijo: graphify **no** gestiona las skills
 * como esta app —elige la carpeta por plataforma en vez de por el estándar abierto, y
 * copia en vez de enlazar—, así que lo que se muestra es a qué carpeta va cada destino y
 * qué hay ahí ahora. Elegir uno reescribe el comando, que después se puede seguir
 * editando a mano. Ver `src-tauri/src/graphify/targets.rs`.
 */
export function GraphifySection() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  /** El proyecto sobre el que se mira: el de la tab activa. Decide dónde caen los destinos
   *  de alcance `project` y en qué carpeta corren los comandos. */
  const cwd = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId)?.cwd ?? tabs[0]?.cwd ?? "",
    [tabs, activeTabId]
  );

  const [view, setView] = useState<View>("install");
  const [extras, setExtras] = useState<string[]>([]);
  const [scope, setScope] = useState<GraphifyScope>("global");
  const [plan, setPlan] = useState<GraphifyPlan | null>(null);
  const [status, setStatus] = useState<GraphifyStatus | null>(null);
  const [commands, setCommands] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, StepRun>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const fresh = await graphifyPlan(cwd, scope);
      setPlan(fresh);
      // Solo la primera vez. Esto se recarga al cambiar de alcance y después de cada paso,
      // y sembrar de nuevo pisaría lo que la persona acaba de escribir o de elegir.
      setCommands((prev) =>
        Object.keys(prev).length > 0 ? prev : Object.fromEntries(fresh.steps.map((s) => [s.id, s.command]))
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [cwd, scope]);

  useEffect(() => { load(); }, [load]);

  // El estado del CLI se pregunta aparte: lanza un proceso y tarda, y el plan no tiene por
  // qué esperarlo para poder mostrar los pasos.
  const refreshStatus = useCallback(() => {
    graphifyStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const targets = useMemo(() => orderedTargets(plan?.targets ?? []), [plan]);
  const selected = targets.find((x) => targetKey(x) === target) ?? targets[0] ?? null;

  const setCommand = (id: string, command: string) => {
    setCommands((prev) => ({ ...prev, [id]: command }));
  };

  /** Elegir un destino reescribe el paso 2. El comando lo arma el backend: los flags y su
   *  orden son de graphify, y escribirlos acá sería una segunda copia de esa regla. */
  const writeInstall = async (platform: string | null, forScope: GraphifyScope) => {
    try {
      setCommand("skill", await graphifyInstallCommand(platform, forScope));
    } catch (e) {
      setError(String(e));
    }
  };

  const chooseTarget = (chosen: GraphifyTarget) => {
    setTarget(targetKey(chosen));
    writeInstall(chosen.platform, scope);
  };

  /** El alcance decide la carpeta igual que la plataforma, así que también reescribe el
   *  comando: si no, la fila marcada muestra una carpeta y el comando instala en otra. */
  const chooseScope = (value: GraphifyScope) => {
    setScope(value);
    writeInstall(selected?.platform ?? null, value);
  };

  /** Ejecutar un comando suelto, en la carpeta del proyecto. Lo comparten los requisitos y
   *  el catálogo, que no tienen por qué saber dónde corre cada cosa. */
  const runCommand = useCallback(async (command: string): Promise<GraphifyRun> => {
    try {
      const result = await graphifyRunStep(command, cwd || ".");
      refreshStatus();
      return result;
    } catch (e) {
      return { ok: false, code: null, output: String(e) };
    }
  }, [cwd, refreshStatus]);

  /** Los extras reescriben el paso 1: `uv tool install "graphifyy[pdf,video]"`. */
  const toggleExtra = async (extra: string) => {
    const next = extras.includes(extra) ? extras.filter((e) => e !== extra) : [...extras, extra];
    setExtras(next);
    try {
      setCommand("cli", await graphifyPackageCommand(commands.cli ?? "", next));
    } catch (e) {
      setError(String(e));
    }
  };

  const runStep = async (id: string) => {
    const command = commands[id] ?? "";
    setRuns((prev) => ({ ...prev, [id]: { running: true, result: null } }));
    try {
      // Se guarda lo que se ejecutó, no lo que se estaba escribiendo: el comando que anduvo
      // es el que tiene que estar la próxima vez que se abra esto.
      await graphifySaveSteps(Object.entries(commands).map(([stepId, cmd]) => ({ id: stepId, command: cmd })));
      const result = await graphifyRunStep(command, cwd || ".");
      setRuns((prev) => ({ ...prev, [id]: { running: false, result } }));
      // Después de cualquier paso cambia lo que hay en disco: el CLI o la skill.
      refreshStatus();
      load();
    } catch (e) {
      setRuns((prev) => ({ ...prev, [id]: { running: false, result: { ok: false, code: null, output: String(e) } } }));
    }
  };

  const runOf = (id: string): StepRun => runs[id] ?? { running: false, result: null };
  const stepHint = (id: string) => t(`settings.graphify.step.${id}.hint`);

  return (
    <SettingsSection
      title={t("settings.graphify")}
      description={t("settings.graphify.desc")}
      action={
        status?.installed ? (
          <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon className="w-3.5 h-3.5" />
            {status.version ?? t("settings.graphify.cli.installed")}
          </span>
        ) : (
          <span className="text-[11px] text-gray-400 dark:text-white/35">
            {t("settings.graphify.cli.missing")}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {/* Requisitos · Instalar · Comandos. En ese orden porque es el orden real: sin
            Python y uv no hay CLI, sin CLI no hay skill, y sin skill no hay comandos. */}
        <div className="flex items-center gap-1.5">
          {(["requirements", "install", "commands"] as View[]).map((value) => (
            <button
              key={value}
              onClick={() => setView(value)}
              className={`cc-t px-2.5 py-1 rounded-lg text-[11.5px]
                ${view === value
                  ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-900 dark:text-white font-semibold"
                  : "bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10"}`}
            >
              {t(`settings.graphify.view.${value}`)}
            </button>
          ))}
        </div>

        {view === "requirements" && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/40">
              {t("settings.graphify.req.desc")}
            </p>
            <RequirementsBlock onRun={runCommand} running={false} />
          </div>
        )}

        {view === "commands" && <CommandCatalog cwd={cwd} onRun={runCommand} />}

        {view === "install" && (
        <div className="flex flex-col gap-5">
        <Step
          title={t("settings.graphify.step.cli")}
          hint={stepHint("cli")}
          command={commands.cli ?? ""}
          onCommand={(v) => setCommand("cli", v)}
          onRun={() => runStep("cli")}
          run={runOf("cli")}
        >
          {/* Las tres formas documentadas. El paso 1 no tiene una sola: en un macOS con
              Python administrado `pip` falla y hace falta pipx. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(plan?.cliAlternatives ?? []).map((alt) => (
              <button
                key={alt}
                onClick={() => setCommand("cli", alt)}
                className={`cc-t px-2 py-0.5 rounded font-mono text-[10px]
                  ${commands.cli === alt
                    ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-800 dark:text-white"
                    : "bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10"}`}
              >
                {alt}
              </button>
            ))}
          </div>
          {/* Los extras del README: cada uno agrega un formato o un backend. Van entre
              comillas en el comando porque zsh trata los corchetes como un glob. */}
          <div className="flex flex-wrap items-center gap-1">
            {(plan?.extras ?? []).map((extra) => (
              <button
                key={extra}
                onClick={() => toggleExtra(extra)}
                className={`cc-t px-1.5 py-0.5 rounded text-[10px]
                  ${extras.includes(extra)
                    ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-800 dark:text-white"
                    : "bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-white/35 hover:bg-gray-200 dark:hover:bg-white/10"}`}
              >
                {extra}
              </button>
            ))}
          </div>
        </Step>

        <Step
          title={t("settings.graphify.step.skill")}
          hint={stepHint("skill")}
          command={commands.skill ?? ""}
          onCommand={(v) => setCommand("skill", v)}
          onRun={() => runStep("skill")}
          run={runOf("skill")}
          disabled={!status?.installed}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              {(["global", "project"] as GraphifyScope[]).map((value) => (
                <button
                  key={value}
                  onClick={() => chooseScope(value)}
                  disabled={value === "project" && !cwd}
                  className={`cc-t px-2.5 py-1 rounded-lg text-[11px] disabled:opacity-40
                    ${scope === value
                      ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-900 dark:text-white font-semibold"
                      : "bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-white/40 hover:bg-gray-200 dark:hover:bg-white/10"}`}
                >
                  {t(`settings.graphify.scope.${value}`)}
                </button>
              ))}
              {scope === "project" && cwd && (
                <span className="flex items-center gap-1 min-w-0 text-[10.5px]
                  text-gray-400 dark:text-white/35">
                  <FolderIcon className="w-3 h-3 shrink-0" />
                  <span className="truncate font-mono">{cwd}</span>
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              {targets.map((item) => (
                <TargetRow
                  key={targetKey(item)}
                  target={item}
                  selected={selected !== null && targetKey(item) === targetKey(selected)}
                  state={skillState(item, status)}
                  onSelect={() => chooseTarget(item)}
                />
              ))}
            </div>

            {/* Lo que hay que saber antes de elegir: en estas dos carpetas la skill de
                graphify va a convivir con las que monta la app. No se pisan —la app solo
                saca sus propios symlinks— pero es una carpeta compartida. */}
            {selected?.sharedWithApp && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg
                bg-gray-100/70 dark:bg-white/4">
                <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0 text-gray-400 dark:text-white/35" />
                <p className="text-[10.5px] leading-relaxed text-gray-500 dark:text-white/40">
                  {t("settings.graphify.sharedDir")}
                </p>
              </div>
            )}
          </div>
        </Step>

        {!status?.installed && (
          <p className="text-[11px] text-gray-400 dark:text-white/35">
            {t("settings.graphify.needsCli")}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-400 dark:text-white/35">
            {t("settings.graphify.usage")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCommands(Object.fromEntries((plan?.defaults ?? []).map((s) => [s.id, s.command])));
              setTarget(null);
            }}
          >
            {t("settings.graphify.reset")}
          </Button>
        </div>

        </div>
        )}

        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </SettingsSection>
  );
}
