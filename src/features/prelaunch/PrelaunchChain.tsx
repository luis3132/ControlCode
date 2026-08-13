import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, TrashIcon, Input, Tooltip } from "neogestify-ui-components";
import {
  PrelaunchStep,
  isPresetStep,
  stepCommand,
  stepLabel,
  usePrelaunchStore,
} from "@/features/prelaunch/store";

interface PrelaunchChainProps {
  value: PrelaunchStep[];
  onChange: (steps: PrelaunchStep[]) => void;
  /** Comando del agente, para poder mostrar la línea final tal como se va a ejecutar. */
  agentCommand?: string;
}

/**
 * Editor de la cadena de comandos que corren antes del agente.
 *
 * Dos decisiones que se ven en pantalla:
 *
 * - **La lista es ordenada y se puede reordenar.** El orden es semántico, no cosmético:
 *   `nvm use 18` tiene que correr antes de cualquier cosa que dependa de npm, y un venv
 *   antes de un `export` que use una ruta suya.
 * - **Se muestra la línea final que se va a ejecutar.** Es lo que separa esto de una caja
 *   negra: se ve el `&&` encadenando y el `exec` al final, así que se entiende por qué un
 *   paso que falla impide que el agente arranque.
 */
export function PrelaunchChain({ value, onChange, agentCommand }: PrelaunchChainProps) {
  const { t } = useTranslation();
  const { presets, loaded, load } = usePrelaunchStore();
  const [draft, setDraft] = useState("");

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);

  const add = (step: PrelaunchStep) => onChange([...value, step]);
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const addDraft = () => {
    const command = draft.trim();
    if (!command) return;
    add({ command });
    setDraft("");
  };

  // Los presets que todavía no están en la cadena. Repetir uno no está prohibido, pero
  // ofrecerlo de nuevo invita a hacerlo por error.
  const available = presets.filter(
    (p) => !value.some((s) => isPresetStep(s) && s.presetId === p.id)
  );

  const resolved = value.map((s) => stepCommand(s, presets)).filter((c): c is string => !!c);
  const preview = resolved.length
    ? `${resolved.join(" && ")} && exec ${agentCommand ?? "<agente>"}`
    : null;

  return (
    <div className="flex flex-col gap-3">
      {value.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {value.map((step, i) => {
            const command = stepCommand(step, presets);
            const label = stepLabel(step, presets);
            const missing = isPresetStep(step) && command === null;
            return (
              <li
                key={`${i}-${isPresetStep(step) ? step.presetId : step.command}`}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs
                  ${missing
                    ? "border-red-300 dark:border-red-500/40 bg-red-50/60 dark:bg-red-500/5"
                    : "border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-white/[0.02]"}`}
              >
                <span className="shrink-0 w-5 h-5 rounded-md grid place-items-center text-[10px]
                  font-semibold bg-gray-200/70 dark:bg-white/10 text-gray-600 dark:text-gray-300">
                  {i + 1}
                </span>

                <div className="min-w-0 flex-1">
                  {label && (
                    <div className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 truncate">
                      {label}
                    </div>
                  )}
                  <code className={`block truncate font-mono text-[11px]
                    ${missing
                      ? "text-red-600 dark:text-red-400"
                      : "text-gray-700 dark:text-gray-200"}`}>
                    {command ?? t("prelaunch.missingPreset")}
                  </code>
                </div>

                {/* Reordenar con flechas y no con drag: son dos o tres pasos, y el drag
                    obligaría a apuntar con precisión para algo que se hace una vez. */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label={t("prelaunch.moveUp")}
                    className="w-6 h-6 grid place-items-center rounded-md text-gray-400
                      hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/60
                      dark:hover:bg-white/10 disabled:opacity-25 disabled:pointer-events-none"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, i + 1)}
                    disabled={i === value.length - 1}
                    aria-label={t("prelaunch.moveDown")}
                    className="w-6 h-6 grid place-items-center rounded-md text-gray-400
                      hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/60
                      dark:hover:bg-white/10 disabled:opacity-25 disabled:pointer-events-none"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={t("btn.delete")}
                    className="w-6 h-6 grid place-items-center rounded-md text-gray-400
                      hover:text-red-500 hover:bg-red-500/10"
                  >
                    <TrashIcon className="w-3 h-3" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          placeholder={t("prelaunch.commandPlaceholder")}
          className="flex-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={!draft.trim()}
          className="shrink-0 px-2.5 rounded-lg border border-gray-200 dark:border-gray-700
            text-gray-500 hover:text-gray-800 dark:hover:text-gray-100
            hover:border-gray-300 dark:hover:border-gray-600
            disabled:opacity-40 disabled:pointer-events-none"
          aria-label={t("prelaunch.addCommand")}
        >
          <AddIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500">
            {t("prelaunch.saved")}
          </span>
          {available.map((preset) => (
            <Tooltip key={preset.id} content={preset.command} placement="top">
              <button
                type="button"
                onClick={() => add({ presetId: preset.id })}
                className="px-2 py-0.5 rounded-full border border-dashed
                  border-gray-300 dark:border-gray-600 text-[11px]
                  text-gray-600 dark:text-gray-300
                  hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400"
              >
                + {preset.name}
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      {preview && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500">
            {t("prelaunch.preview")}
          </span>
          <code className="block px-2.5 py-2 rounded-lg font-mono text-[11px] leading-relaxed
            bg-gray-900/90 dark:bg-black/40 text-gray-100 overflow-x-auto whitespace-pre">
            {preview}
          </code>
        </div>
      )}
    </div>
  );
}
