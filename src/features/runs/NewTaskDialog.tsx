import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Button, SegmentedControl, Select } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { repoInfo } from "@/features/explorer/ipc";
import { AccountPickerStep, AUTO_ACCOUNT } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";

import { getRoster, previewRoute, type RouteInput, type StartOrchestrationInput, type StartTaskInput } from "./ipc";
import { COMPLEXITIES, describeAssignment, launchableAgents } from "./routingView";
import type { Assignment, Complexity, Roster } from "./types";

/** Cómo se elige el modelo: por complejidad (lo decide el ruteo) o uno fijo. */
type ModelMode = Complexity | "fixed";

/** Una tarea para un agente, o un objetivo para que un lead lo reparta entre varios. */
type LaunchKind = "task" | "orchestrate";

export type NewLaunch =
  | ({ kind: "task" } & Omit<StartTaskInput, "workspaceId" | "cwd">)
  | ({ kind: "orchestrate" } & Omit<StartOrchestrationInput, "workspaceId" | "cwd">);

const PARALLEL = [1, 2, 3, 4] as const;

/**
 * Lanzar trabajo en segundo plano: una tarea para un agente, o un objetivo que un lead
 * reparte en un plan de tareas para varios. Qué tiene que hacer, con qué modelo y cuenta,
 * y hasta cuánto gastar.
 */
export function NewTaskDialog({ cwd, busyInFolder, onClose, onStart }: {
  cwd: string;
  /** Agentes trabajando YA sobre esta carpeta (no en un worktree propio). */
  busyInFolder: number;
  onClose: () => void;
  onStart: (input: NewLaunch) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LaunchKind>("task");
  const [maxParallel, setMaxParallel] = useState<number>(2);
  const [roster, setRoster] = useState<Roster | null>(null);
  // Hasta que llega el roster se asume la única que se sabe correr hoy: el diálogo no
  // puede quedar en blanco esperando un sondeo que la primera vez lanza procesos.
  const [agentId, setAgentId] = useState("claude-code");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // "Estándar" y cuenta automática: lo que hace falta pensar es QUÉ tan difícil es la
  // tarea, no qué modelo y qué cuenta tocan hoy — eso lo sabe el roster mejor que nadie.
  const [mode, setMode] = useState<ModelMode>("standard");
  const [fixedModel, setFixedModel] = useState("");
  const [accountId, setAccountId] = useState<string | undefined>(AUTO_ACCOUNT);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** `null` = todavía no se sabe si la carpeta es un repo. */
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [isolate, setIsolate] = useState(false);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [routeError, setRouteError] = useState("");

  useEffect(() => {
    repoInfo(cwd)
      .then((info) => {
        const repo = info.root !== null;
        setIsRepo(repo);
        // Encendido solo si hace falta: con otro agente ya trabajando en la carpeta, el
        // segundo editaría los mismos archivos. Con la carpeta libre no hay choque, y un
        // worktree sería una copia del repo y una rama que nadie pidió.
        setIsolate(repo && busyInFolder > 0);
      })
      .catch(() => setIsRepo(false));
  }, [cwd, busyInFolder]);

  useEffect(() => {
    getRoster().then(setRoster).catch((e) => setRouteError(String(e)));
  }, []);

  // Las TUIs que se ofrecen salen del roster: "se sabe correr sin terminal" es algo que
  // decide el backend (tiene o no adaptador), no una lista copiada acá.
  const agents = launchableAgents(roster);
  const agent = agents.find((a) => a.agentId === agentId);
  const models = useMemo(
    () => (agent?.models ?? []).filter((m) => !m.unavailable && m.toolcall !== false),
    [agent]
  );

  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.id === fixedModel)) {
      setFixedModel(models.find((m) => m.id === "sonnet")?.id ?? models[0].id);
    }
  }, [models, fixedModel]);

  const route: RouteInput = useMemo(() => ({
    // Con complejidad no se fija el agente: es el ruteo el que decide cuál conviene.
    agentId: mode === "fixed" ? agentId : null,
    model: mode === "fixed" ? fixedModel || null : null,
    complexity: mode === "fixed" ? null : mode,
    accountId: accountId === AUTO_ACCOUNT ? null : (accountId ?? null),
    autoAccount: accountId === AUTO_ACCOUNT,
  }), [mode, agentId, fixedModel, accountId]);

  // Se muestra a quién le toca ANTES de lanzar. Enterarse de que fue a otra cuenta o a
  // otro modelo al ver la tarjeta sería enterarse tarde.
  useEffect(() => {
    let stale = false;
    previewRoute(route)
      .then((a) => { if (!stale) { setAssignment(a); setRouteError(""); } })
      .catch((e) => { if (!stale) { setAssignment(null); setRouteError(String(e)); } });
    return () => { stale = true; };
    // `roster` también: el primer sondeo puede cambiar lo que había disponible.
  }, [route, roster]);

  const canStart = prompt.trim().length > 0 && !busy && !routeError;

  const changeKind = (next: LaunchKind) => {
    setKind(next);
    // De cómo reparte el lead depende lo que cuesta todo lo demás: se propone el tramo
    // difícil, y al volver a una tarea suelta, el de todos los días.
    if (mode !== "fixed") setMode(next === "orchestrate" ? "hard" : "standard");
  };

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await onStart(kind === "orchestrate"
        ? { kind, ...route, objective: prompt.trim(), maxParallel, budgetUsd: parseBudget(budget) }
        : {
          kind,
          ...route,
          // Sin título propio, la primera línea del pedido: es lo que el usuario escribió
          // para describirlo, así que es mejor nombre que "Tarea 3".
          title: title.trim() || firstLine(prompt),
          prompt: prompt.trim(),
          budgetUsd: parseBudget(budget),
          isolate: Boolean(isRepo) && isolate,
        });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const Icon = agentIcon(assignment?.agentId ?? agentId);

  return (
    <AppDialog
      title={kind === "orchestrate" ? t("fleet.orchestrate.title") : t("fleet.new.title")}
      icon={<Icon className="w-4 h-4 text-gray-500 dark:text-white/50" />}
      size="md"
      closeOnEsc
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2 px-4 h-12">
          <span className="flex-1 min-w-0 truncate font-mono text-[10px]
            text-gray-400 dark:text-white/30">
            {cwd}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>{t("btn.cancel")}</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canStart}
            onClick={start}
            leftIcon={busy ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {kind === "orchestrate" ? t("fleet.orchestrate.start") : t("fleet.new.start")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <SegmentedControl
          size="sm"
          aria-label={t("fleet.orchestrate.kind")}
          value={kind}
          onChange={(v) => changeKind(v as LaunchKind)}
          options={[
            { value: "task", label: t("fleet.orchestrate.kindTask") },
            { value: "orchestrate", label: t("fleet.orchestrate.kindOrchestrate") },
          ]}
        />
        {kind === "orchestrate" && (
          <p className="-mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-white/40">
            {t("fleet.orchestrate.explain")}
          </p>
        )}

        {agents.length > 1 && (
          <Field group label={t("fleet.new.agent")}>
            <div className="flex gap-1.5">
              {agents.map((a) => (
                <button
                  key={a.agentId}
                  onClick={() => { setAgentId(a.agentId); setAccountId(AUTO_ACCOUNT); }}
                  className={`cc-t px-2 h-7 rounded-lg text-[11.5px]
                    ${a.agentId === agentId
                      ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                      : "text-gray-600 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/8"}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </Field>
        )}

        <Field
          label={kind === "orchestrate" ? t("fleet.orchestrate.objective") : t("fleet.new.prompt")}
          hint={kind === "orchestrate" ? t("fleet.orchestrate.objectiveHint") : t("fleet.new.promptHint")}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={kind === "orchestrate" ? 6 : 5}
            autoFocus
            placeholder={kind === "orchestrate" ? t("fleet.orchestrate.objectivePlaceholder") : t("fleet.new.promptPlaceholder")}
            className="w-full resize-none rounded-lg px-2.5 py-2 outline-none
              bg-gray-100 dark:bg-white/5
              border border-gray-200 dark:border-white/10
              focus:border-blue-400 dark:focus:border-blue-500
              text-[12px] leading-relaxed text-gray-800 dark:text-gray-200"
          />
        </Field>

        {kind === "task" && (
          <Field label={t("fleet.new.name")} hint={t("fleet.new.nameHint")}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={INPUT}
            />
          </Field>
        )}

        {kind === "orchestrate" && (
          <Field group label={t("fleet.orchestrate.parallel")} hint={t("fleet.orchestrate.parallelHint")}>
            <SegmentedControl
              size="sm"
              aria-label={t("fleet.orchestrate.parallel")}
              value={String(maxParallel)}
              onChange={(v) => setMaxParallel(Number(v))}
              options={PARALLEL.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </Field>
        )}

        <Field
          group
          label={kind === "orchestrate" ? t("fleet.orchestrate.leadModel") : t("fleet.new.model")}
          hint={mode === "fixed" ? undefined : t("fleet.new.modelHint")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              aria-label={t("fleet.new.model")}
              value={mode}
              onChange={(v) => setMode(v as ModelMode)}
              options={[
                ...COMPLEXITIES.map((c) => ({ value: c, label: t(`fleet.complexity.${c}`) })),
                { value: "fixed", label: t("fleet.new.fixedModel") },
              ]}
            />
            {mode === "fixed" && models.length > 0 && (
              <Select
                size="sm"
                variant="outline"
                aria-label={t("fleet.new.fixedModel")}
                value={fixedModel}
                onChange={(e) => setFixedModel(e.target.value)}
                options={models.map((m) => ({ value: m.id, label: m.label }))}
              />
            )}
          </div>
        </Field>

        <Field group label={t("fleet.new.account")}>
          <AccountPickerStep
            agentId={agentId}
            value={accountId}
            onChange={setAccountId}
            showLabel={false}
            allowAuto
          />
        </Field>

        <div className="w-40">
          <Field
            label={kind === "orchestrate" ? t("fleet.orchestrate.budget") : t("fleet.new.budget")}
            hint={t("fleet.new.budgetHint")}
          >
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              placeholder="1.00"
              className={INPUT}
            />
          </Field>
        </div>

        <RoutePreview roster={roster} assignment={assignment} error={routeError} />

        {kind === "task" && <div className="flex flex-col gap-1.5">
          <label className={`flex items-start gap-2 select-none
            ${isRepo ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
            <input
              type="checkbox"
              checked={Boolean(isRepo) && isolate}
              disabled={!isRepo}
              onChange={(e) => setIsolate(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[11.5px] font-semibold text-gray-700 dark:text-gray-300">
                {t("fleet.new.isolate")}
              </span>
              <span className="text-[10.5px] leading-relaxed text-gray-400 dark:text-white/35">
                {isRepo === false ? t("fleet.new.isolateNoRepo") : t("fleet.new.isolateHint")}
              </span>
            </span>
          </label>
          {/* Se avisa ANTES de lanzar, no después: enterarse de que dos agentes se pisaron
              los archivos recién al ver el resultado es enterarse tarde. */}
          {busyInFolder > 0 && !(isRepo && isolate) && (
            <Alert variant="warning">{t("fleet.new.collision", { n: busyInFolder })}</Alert>
          )}
        </div>}
        {kind === "orchestrate" && isRepo === false && (
          <Alert variant="warning">{t("fleet.orchestrate.noRepo")}</Alert>
        )}

        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}

/**
 * A quién le toca la tarea con lo elegido: agente, modelo, cuenta y cuánto le queda a esa
 * cuenta. Lo descartado va debajo, con su motivo — "fue a la cuenta de trabajo" sin decir
 * que la principal no tenía cupo parece un error.
 */
function RoutePreview({ roster, assignment, error }: {
  roster: Roster | null;
  assignment: Assignment | null;
  error: string;
}) {
  const { t } = useTranslation();

  if (error) return <Alert variant="danger">{error}</Alert>;
  if (!assignment) return null;

  const view = describeAssignment(roster, assignment, Math.floor(Date.now() / 1000));
  const parts = [
    view.agentLabel,
    view.model ?? t("fleet.route.defaultModel"),
    view.account && (view.account.system ? t("accounts.system") : view.account.name),
    view.percent !== null ? t("fleet.route.window", { pct: view.percent }) : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-1 px-2.5 py-2 rounded-lg
      bg-gray-100/70 dark:bg-white/4 border border-gray-200/70 dark:border-white/8">
      <span className="flex items-baseline gap-1.5 min-w-0 text-[11.5px]">
        <span className="shrink-0 text-gray-400 dark:text-white/35">{t("fleet.route.goesTo")}</span>
        <span className="truncate font-medium text-gray-800 dark:text-gray-200">
          {parts.join(" · ")}
        </span>
      </span>
      {assignment.notes.map((note) => (
        <span key={note} className="text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400/90">
          {note}
        </span>
      ))}
    </div>
  );
}

function Field({ label, hint, group = false, children }: {
  label: string;
  hint?: string;
  /**
   * Un grupo de botones y no un campo. Va en un `div`: dentro de un `<label>`, un click en
   * el título se reenvía al primer botón, y tocar "Cuenta" elegía una cuenta.
   */
  group?: boolean;
  children: React.ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="flex flex-col gap-1.5" {...(group ? { role: "group", "aria-label": label } : {})}>
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
          {label}
        </span>
        {hint && (
          <span className="text-[10px] text-gray-400 dark:text-white/30">{hint}</span>
        )}
      </span>
      {children}
    </Tag>
  );
}

const INPUT = `w-full rounded-lg px-2.5 h-8 outline-none text-[12px]
  bg-gray-100 dark:bg-white/5
  border border-gray-200 dark:border-white/10
  focus:border-blue-400 dark:focus:border-blue-500
  text-gray-800 dark:text-gray-200`;

function firstLine(s: string): string {
  const line = s.trim().split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Un presupuesto vacío o ilegible es "sin tope", no cero: cero no dejaría hacer nada. */
function parseBudget(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}
