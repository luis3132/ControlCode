import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, ChevronRightIcon, DocumentIcon, Tooltip } from "neogestify-ui-components";

import { DotsIcon } from "@/app/icons";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { searchText, type SearchOptions } from "./ipc";
import { useSearchStore } from "./store";

/** Un interruptor de opción, como los de VS Code: una letra o dos dentro del campo. */
function OptionToggle({ label, title, on, onToggle }: {
  label: string;
  title: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip content={title} placement="bottom">
      <button
        onClick={onToggle}
        aria-label={title}
        aria-pressed={on}
        className={`cc-t flex items-center justify-center min-w-5.5 h-5.5 px-1 rounded-md shrink-0
          font-mono text-[10.5px] font-semibold
          ${on
            ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-300 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.45)]"
            : "text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"}`}
      >
        {label}
      </button>
    </Tooltip>
  );
}

/** La línea de un resultado con la coincidencia resaltada. `start`/`end` vienen en UTF-16,
 *  que es como indexa JS: `slice` los usa tal cual. */
function Preview({ text, start, end }: { text: string; start: number; end: number }) {
  return (
    <span className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">
      {text.slice(0, start)}
      <mark className="rounded-sm px-px bg-amber-300/60 text-gray-900 dark:bg-amber-400/30 dark:text-amber-100">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </span>
  );
}

/**
 * Buscar texto en todo el workspace, como el buscador de VS Code: con mayúsculas, palabra
 * completa y regex; con globs para incluir o excluir; y un click en un resultado abre el
 * archivo como tab con el cursor en esa línea.
 *
 * Busca mientras se escribe, con una espera corta. Cada tecla lanza una búsqueda nueva y
 * el backend corta la anterior, así que tipear rápido no encola trabajo.
 */
export function SearchPanel({ cwd }: { cwd: string | null }) {
  const { t } = useTranslation();
  const openFile = useViewTabsStore((s) => s.openFile);
  const { query, options, showFilters, result, resultRoot, collapsed } = useSearchStore();
  const { setQuery, setOption, toggleFilters, setResult, toggleFile } = useSearchStore.getState();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Llegar al buscador es para escribir.
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  useEffect(() => {
    if (!cwd || !query) {
      setResult(cwd ?? "", null);
      setError(null);
      return;
    }
    let stale = false;
    const handle = setTimeout(() => {
      setSearching(true);
      searchText(cwd, query, options)
        .then((r) => {
          // Una búsqueda que el backend cortó porque llegó otra no trae nada que mostrar.
          if (stale || r.cancelled) return;
          setResult(cwd, r);
          setError(null);
        })
        .catch((e) => { if (!stale) { setError(String(e)); setResult(cwd, null); } })
        .finally(() => { if (!stale) setSearching(false); });
    }, 250);
    return () => { stale = true; clearTimeout(handle); };
  }, [cwd, query, options, setResult]);

  const shown = resultRoot === cwd ? result : null;
  const toggle = (key: keyof Pick<SearchOptions, "isRegex" | "caseSensitive" | "wholeWord">) =>
    setOption(key, !options[key]);

  return (
    <>
      <div className="flex flex-col gap-1.5 shrink-0 px-2.5 pt-2.5 pb-2
        border-b border-gray-200 dark:border-white/7">
        <div className="flex items-center gap-0.5 h-8 pl-2.5 pr-1 rounded-lg
          bg-white dark:bg-white/4
          border border-gray-200 dark:border-white/10
          focus-within:border-blue-500 dark:focus-within:border-blue-400">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px]
              text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
          <OptionToggle label="Aa" title={t("search.caseSensitive")} on={options.caseSensitive} onToggle={() => toggle("caseSensitive")} />
          <OptionToggle label="ab" title={t("search.wholeWord")} on={options.wholeWord} onToggle={() => toggle("wholeWord")} />
          <OptionToggle label=".*" title={t("search.regex")} on={options.isRegex} onToggle={() => toggle("isRegex")} />
        </div>

        <div className="flex items-center gap-2 min-h-5">
          <span className="flex-1 min-w-0 truncate text-[10.5px] tabular-nums text-gray-400 dark:text-white/35">
            {searching && !shown
              ? t("search.searching")
              : shown
                ? shown.matchCount === 0
                  ? t("search.none")
                  : t(shown.truncated ? "search.countTruncated" : "search.count", {
                      matches: shown.matchCount, files: shown.files.length,
                    })
                : ""}
          </span>
          <Tooltip content={t("search.filters")} placement="left">
            <button
              onClick={toggleFilters}
              aria-label={t("search.filters")}
              aria-pressed={showFilters}
              className={`cc-t flex items-center justify-center w-5.5 h-5.5 rounded-md shrink-0
                ${showFilters || options.include || options.exclude
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white"}
                hover:bg-gray-200 dark:hover:bg-white/10`}
            >
              <DotsIcon className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>

        {showFilters && (
          <div className="flex flex-col gap-1.5">
            {(["include", "exclude"] as const).map((key) => (
              <label key={key} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-gray-400 dark:text-white/35">{t(`search.${key}`)}</span>
                <input
                  value={options[key]}
                  onChange={(e) => setOption(key, e.target.value)}
                  placeholder={key === "include" ? "src/**, *.ts" : "*.test.ts, dist"}
                  spellCheck={false}
                  className="h-7 px-2 rounded-md outline-none font-mono text-[11px]
                    bg-white dark:bg-white/4 border border-gray-200 dark:border-white/10
                    focus:border-blue-500 dark:focus:border-blue-400
                    text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-white/20"
                />
              </label>
            ))}
          </div>
        )}

        {error && <p className="text-[11px] text-red-500 dark:text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex-1 min-h-0 cc-scroll py-1">
        {!cwd ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-gray-400 dark:text-white/30">
            {t("explorer.noTab")}
          </p>
        ) : shown?.files.map((file) => {
          const open = !collapsed.has(file.path);
          const slash = file.rel.lastIndexOf("/");
          const name = file.rel.slice(slash + 1);
          const dir = slash > 0 ? file.rel.slice(0, slash) : "";
          return (
            <div key={file.path}>
              <button
                onClick={() => toggleFile(file.path)}
                className="flex items-center gap-1.5 w-full h-[22px] pl-1.5 pr-2 text-left
                  hover:bg-gray-200/50 dark:hover:bg-white/4"
              >
                <span className="w-3 shrink-0 text-gray-400 dark:text-white/30">
                  {open ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
                </span>
                <DocumentIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />
                <span className="shrink-0 max-w-[60%] truncate text-[11.5px] font-semibold text-gray-700 dark:text-gray-300">
                  {name}
                </span>
                <span className="flex-1 min-w-0 truncate text-[10.5px] text-gray-400 dark:text-white/30" dir="rtl">
                  {dir}
                </span>
                <span className="shrink-0 px-1.5 rounded-full text-[9.5px] tabular-nums
                  bg-gray-200 text-gray-600 dark:bg-white/8 dark:text-gray-400">
                  {file.matches.length}
                </span>
              </button>
              {open && file.matches.map((m, i) => (
                <button
                  key={`${m.line}:${m.column}:${i}`}
                  onClick={() => openFile(cwd, file.path, { line: m.line, column: m.column })}
                  className="flex items-center gap-2 w-full h-[22px] pl-9 pr-2 text-left
                    hover:bg-blue-500/8 dark:hover:bg-blue-400/8"
                >
                  <span className="shrink-0 w-7 text-right font-mono text-[10px] tabular-nums text-gray-300 dark:text-white/20">
                    {m.line}
                  </span>
                  <Preview text={m.preview} start={m.start} end={m.end} />
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
