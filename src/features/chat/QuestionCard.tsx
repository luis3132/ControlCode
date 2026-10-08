import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { useRunsStore } from "@/features/runs/store";
import type { PendingApproval } from "@/features/runs/types";

interface Option {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: Option[];
  multiSelect?: boolean;
}

/** Las preguntas que trae el input de `AskUserQuestion`, ignorando lo que no tenga forma. */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object" || typeof (q as Question).question !== "string") return [];
    const options = Array.isArray((q as Question).options)
      ? (q as Question).options.filter((o) => o && typeof o.label === "string")
      : [];
    return [{ ...(q as Question), options }];
  });
}

/** La respuesta de cada pregunta como la recibe la herramienta: las opciones elegidas (y lo
 *  escrito a mano) separadas por coma. Las que quedan sin contestar no van. */
export function answersOf(
  questions: Question[],
  picked: Record<string, string[]>,
  other: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const parts = [...(picked[q.question] ?? []), (other[q.question] ?? "").trim()].filter(Boolean);
    if (parts.length > 0) out[q.question] = parts.join(", ");
  }
  return out;
}

/**
 * Lo que reemplaza al selector de la TUI cuando el agente pregunta (`AskUserQuestion`):
 * cada pregunta con sus opciones, y un campo para contestar otra cosa. La respuesta viaja
 * por el puente de permisos, adentro del input de la herramienta, que es como la recibe.
 */
export function QuestionCard({ approval }: { approval: PendingApproval }) {
  const { t } = useTranslation();
  const answerQuestion = useRunsStore((s) => s.answerQuestion);
  const decideApproval = useRunsStore((s) => s.decideApproval);
  const questions = questionsOf(approval.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answers = answersOf(questions, picked, other);
  const complete = questions.length > 0 && questions.every((q) => answers[q.question]);

  const toggle = (q: Question, label: string) =>
    setPicked((cur) => {
      const now = cur[q.question] ?? [];
      const next = q.multiSelect
        ? now.includes(label) ? now.filter((l) => l !== label) : [...now, label]
        : now.includes(label) ? [] : [label];
      return { ...cur, [q.question]: next };
    });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3 rounded-lg border border-blue-300/70 dark:border-blue-500/30
      bg-blue-50/60 dark:bg-blue-500/[0.06]">
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
              {q.header}
            </span>
          )}
          <span className="text-[13px] font-medium text-gray-900 dark:text-white">{q.question}</span>
          {q.multiSelect && (
            <span className="text-[10.5px] text-gray-500 dark:text-white/40">{t("chat.question.several")}</span>
          )}
          <div className="flex flex-col gap-1">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <Button key={o.label} variant="custom" disabled={busy} onClick={() => toggle(q, o.label)}
                  aria-pressed={on}
                  className={`cc-t w-full flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-md text-left border
                    ${on
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-gray-200 dark:border-white/10 hover:bg-white dark:hover:bg-white/5"}`}>
                  <span className="text-[12.5px] text-gray-800 dark:text-gray-100">{o.label}</span>
                  {o.description && (
                    <span className="text-[11px] text-gray-500 dark:text-white/45">{o.description}</span>
                  )}
                </Button>
              );
            })}
          </div>
          <Input
            value={other[q.question] ?? ""}
            onChange={(e) => setOther((cur) => ({ ...cur, [q.question]: e.target.value }))}
            placeholder={t("chat.question.other")}
            variant="outline"
            size="sm"
            disabled={busy}
          />
        </div>
      ))}
      {error && <p className="text-[11px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      <div className="flex items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={busy || !complete}
          onClick={() => void run(() => answerQuestion(approval.id, answers))}>
          {t("chat.question.answer")}
        </Button>
        <Button variant="custom" disabled={busy}
          onClick={() => void run(() => decideApproval(approval.id, false, false))}
          className="cc-t h-7 px-3 rounded-md text-[11.5px] text-gray-600 dark:text-white/60 hover:bg-gray-200 dark:hover:bg-white/10">
          {t("chat.question.skip")}
        </Button>
      </div>
    </div>
  );
}
