import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AnimateSpin, Button } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { repoInfo } from "@/features/explorer/ipc";
import { AccountPickerStep } from "@/features/tabs/wizard/AccountPickerStep";
import { AppDialog } from "@/shared/ui/AppDialog";

import type { StartTaskInput } from "./ipc";

/**
 * Las TUIs que la app sabe correr sin terminal.
 *
 * Es una sola por ahora, y la lista está acá y no en el registro de agentes porque "sabe
 * correr headless" no es una propiedad de la TUI sino de si escribimos su adaptador:
 * `codex exec` y `opencode run --format json` existen, pero todavía nadie los probó desde
 * acá, y ofrecerlos sin adaptador daría una tarjeta que falla al lanzar.
 */
const HEADLESS_AGENTS = ["claude-code"];

/** Lanzar un agente headless: qué tiene que hacer, con qué cuenta y hasta cuánto gastar. */
export function NewTaskDialog({ cwd, busyInFolder, onClose, onStart }: {
  cwd: string;
  /** Agentes trabajando YA sobre esta carpeta (no en un worktree propio). */
  busyInFolder: number;
  onClose: () => void;
  onStart: (input: Omit<StartTaskInput, "workspaceId" | "cwd">) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(HEADLESS_AGENTS[0]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** `null` = todavía no se sabe si la carpeta es un repo. */
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [isolate, setIsolate] = useState(false);

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

  const canStart = prompt.trim().length > 0 && !busy;

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await onStart({
        agentId,
        // Sin título propio, la primera línea del pedido: es lo que el usuario escribió
        // para describirlo, así que es mejor nombre que "Tarea 3".
        title: title.trim() || firstLine(prompt),
        prompt: prompt.trim(),
        accountId: accountId ?? null,
        budgetUsd: parseBudget(budget),
        isolate: Boolean(isRepo) && isolate,
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const Icon = agentIcon(agentId);

  return (
    <AppDialog
      title={t("fleet.new.title")}
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
            {t("fleet.new.start")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        {HEADLESS_AGENTS.length > 1 && (
          <Field label={t("fleet.new.agent")}>
            <div className="flex gap-1.5">
              {HEADLESS_AGENTS.map((id) => (
                <button
                  key={id}
                  onClick={() => { setAgentId(id); setAccountId(undefined); }}
                  className={`cc-t px-2 h-7 rounded-lg text-[11.5px]
                    ${id === agentId
                      ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                      : "text-gray-600 dark:text-white/50 hover:bg-gray-200 dark:hover:bg-white/8"}`}
                >
                  {id}
                </button>
              ))}
            </div>
          </Field>
        )}

        <Field label={t("fleet.new.prompt")} hint={t("fleet.new.promptHint")}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            autoFocus
            placeholder={t("fleet.new.promptPlaceholder")}
            className="w-full resize-none rounded-lg px-2.5 py-2 outline-none
              bg-gray-100 dark:bg-white/5
              border border-gray-200 dark:border-white/10
              focus:border-blue-400 dark:focus:border-blue-500
              text-[12px] leading-relaxed text-gray-800 dark:text-gray-200"
          />
        </Field>

        <Field label={t("fleet.new.name")} hint={t("fleet.new.nameHint")}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={INPUT}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("fleet.new.account")}>
            <AccountPickerStep agentId={agentId} value={accountId} onChange={setAccountId} />
          </Field>
          <Field label={t("fleet.new.budget")} hint={t("fleet.new.budgetHint")}>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              placeholder="1.00"
              className={INPUT}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
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
        </div>

        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </AppDialog>
  );
}

function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">
          {label}
        </span>
        {hint && (
          <span className="text-[10px] text-gray-400 dark:text-white/30">{hint}</span>
        )}
      </span>
      {children}
    </label>
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
