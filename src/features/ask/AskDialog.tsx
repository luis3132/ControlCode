import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";
import { agentPaint } from "@/features/browser/agentPaint";
import { useAskStore } from "./askStore";

/** `2:05` — lo que queda antes de que la pregunta se venza sola. */
function left(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Lo que un agente pregunta cuando no lo puede averiguar leyendo.
 *
 * De a una: con varios agentes corriendo, dos diálogos encima no se pueden contestar, y el
 * que quedó atrás no se ve. Las demás esperan su turno — igual están bloqueadas del otro
 * lado, así que la cola es real, no una simplificación.
 *
 * Cerrar es una respuesta válida ("no te contesto"), y el agente lo recibe como tal: dejarlo
 * esperando media hora a algo que la persona ya decidió no contestar es peor.
 */
export function AskDialog() {
  const { t } = useTranslation();
  const question = useAskStore((s) => s.questions[0]);
  const answer = useAskStore((s) => s.answer);
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Cada pregunta arranca limpia: lo tipeado para la anterior no es una respuesta a esta,
  // y el reloj tiene que contar desde AHORA (el estado venía de cuando se montó el shell).
  useEffect(() => {
    setText("");
    setNow(Date.now());
  }, [question?.id]);

  useEffect(() => {
    if (!question) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [question]);

  if (!question) return null;
  const paint = agentPaint(question.fromId);
  const remaining = question.expiresAt - now;
  const free = question.options.length === 0;

  return (
    <AppDialog
      title={t("ask.title", { agent: question.from })}
      size="sm"
      onClose={() => answer(question.id, null)}
      closeOnEsc
      footer={
        <>
          <Button variant="outline" onClick={() => answer(question.id, null)}>
            {t("ask.skip")}
          </Button>
          {free && (
            <Button variant="primary" disabled={!text.trim()} onClick={() => answer(question.id, text.trim())}>
              {t("ask.send")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* La pregunta la escribió un agente: va como cita, no como texto de la app. La
            barrita es del color de quien pregunta, el mismo de su tab. */}
        <div className={`flex gap-2.5 px-3 py-2.5 rounded-lg ${paint.tint}`}>
          <span className={`w-[3px] shrink-0 rounded-full ${paint.strip}`} />
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-200">
            {question.question}
          </p>
        </div>

        {free ? (
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) answer(question.id, text.trim());
            }}
            placeholder={question.placeholder || t("ask.placeholder")}
            variant="outline"
            autoFocus
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {question.options.map((option) => (
              <button
                key={option}
                onClick={() => answer(question.id, option)}
                className="cc-t text-left px-3 py-2 rounded-lg text-[12.5px]
                  border border-gray-200 dark:border-white/10
                  text-gray-800 dark:text-gray-200
                  hover:bg-gray-100 dark:hover:bg-white/8
                  hover:border-gray-300 dark:hover:border-white/20"
              >
                {option}
              </button>
            ))}
          </div>
        )}

        <p className="text-[11px] text-gray-400 dark:text-white/35">
          {t("ask.waiting", { time: left(remaining) })}
        </p>
      </div>
    </AppDialog>
  );
}
