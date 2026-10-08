import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { agentWords } from "./ipc";
import { addWord, removeWord, useWorkingWords } from "./workingWords";

/**
 * Las palabras del "trabajando" del chat, para mirarlas y editarlas.
 *
 * Arranca con las que trae la propia TUI —el texto es de ella, no de la app— y la primera
 * edición se queda con esa lista como punto de partida. "Restaurar" vuelve a las suyas, que
 * además se actualizan solas cuando se actualiza Claude Code.
 */
export function WorkingWordsSetting() {
  const { t } = useTranslation();
  const custom = useWorkingWords((s) => s.custom);
  const load = useWorkingWords((s) => s.load);
  const save = useWorkingWords((s) => s.save);
  const [fromTui, setFromTui] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    load().catch(console.error);
    agentWords("claude-code").then(setFromTui).catch(console.error);
  }, [load]);

  const words = custom ?? fromTui;
  const edit = (next: string[]) => {
    // Quitar la última dejaría el chat sin nada que decir: ahí vuelve a las de la TUI.
    save(next.length > 0 ? next : null).catch(console.error);
  };
  const add = () => {
    const next = addWord(words, draft);
    setDraft("");
    input.current?.focus();
    if (next !== words) edit(next);
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-gray-100/70 dark:bg-white/4">
      <div className="flex items-start gap-3">
        <span className="flex flex-col gap-px min-w-0 flex-1">
          <span className="text-[12px] text-gray-700 dark:text-gray-300">{t("settings.words")}</span>
          <span className="text-[10.5px] leading-relaxed text-gray-400 dark:text-white/35">
            {custom ? t("settings.words.mine", { n: words.length }) : t("settings.words.fromTui", { n: words.length })}
          </span>
        </span>
        {custom && (
          <Button variant="ghost" size="sm" onClick={() => edit([])}>
            {t("settings.words.restore")}
          </Button>
        )}
      </div>

      {words.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
          {words.map((word, i) => (
            <span
              key={word}
              className="flex items-center gap-0.5 h-6 pl-2 pr-0.5 rounded-md text-[11px]
                bg-white dark:bg-white/6 border border-gray-200 dark:border-white/10
                text-gray-700 dark:text-gray-200"
            >
              {word}
              <button
                onClick={() => edit(removeWord(words, i))}
                aria-label={t("settings.words.remove", { word })}
                title={t("settings.words.remove", { word })}
                className="cc-t flex items-center justify-center w-4 h-4 rounded text-[11px]
                  text-gray-400 dark:text-white/40
                  hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
          }}
          placeholder={t("settings.words.placeholder")}
          className="flex-1 min-w-0 h-7 px-2 rounded-md outline-none text-[11.5px]
            bg-white dark:bg-white/5
            border border-gray-200 dark:border-white/10
            focus:border-blue-400 dark:focus:border-blue-500
            text-gray-800 dark:text-gray-200"
        />
        <Button variant="ghost" size="sm" disabled={!draft.trim()} onClick={add}>
          {t("settings.words.add")}
        </Button>
      </div>
    </div>
  );
}
