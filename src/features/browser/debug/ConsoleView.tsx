import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrashIcon } from "neogestify-ui-components";

import { appendBatch, clearConsole, EMPTY_LOG, formatClock, type DocMark, type LoggedConsole } from "../debugLog";
import { useDebugStore } from "../debugStore";
import type { PageChannel } from "../pageChannel";
import type { ConsoleEntry } from "../protocol";
import { Empty, FilterChip, IconAction, PanelToolbar, SearchField } from "./parts";

type Level = "all" | "errors" | "warnings" | "logs";

type Row = { id: number; doc: DocMark; entry?: undefined } | { id: number; entry: LoggedConsole; doc?: undefined };

/** Más que esto en el DOM a la vez vuelve lento al panel, y nadie lee 2000 líneas seguidas. */
const SHOWN = 600;

const TONE: Record<string, string> = {
  error: "bg-red-50/80 dark:bg-red-500/[0.07] text-red-700 dark:text-red-300 border-red-200/60 dark:border-red-500/15",
  warn: "bg-amber-50/80 dark:bg-amber-500/[0.07] text-amber-800 dark:text-amber-200 border-amber-200/60 dark:border-amber-500/15",
  info: "text-gray-800 dark:text-gray-200 border-gray-100 dark:border-white/5",
  log: "text-gray-800 dark:text-gray-200 border-gray-100 dark:border-white/5",
  debug: "text-gray-500 dark:text-white/45 border-gray-100 dark:border-white/5",
};

const MARK: Record<string, string> = {
  error: "bg-red-500", warn: "bg-amber-500", info: "bg-blue-400", log: "bg-gray-300 dark:bg-white/20", debug: "bg-transparent",
};

function matches(entry: LoggedConsole, level: Level): boolean {
  if (level === "errors") return entry.level === "error";
  if (level === "warnings") return entry.level === "warn";
  if (level === "logs") return entry.level !== "error" && entry.level !== "warn";
  return true;
}

function showValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2) ?? "undefined";
}

/**
 * La consola de la página. Sobrevive a las recargas —cada carga es un separador— porque
 * el error que importa suele ser el de justo antes de un redirect.
 */
export function ConsoleView({ viewId, channel }: { viewId: string; channel: PageChannel }) {
  const { t } = useTranslation();
  const log = useDebugStore((s) => s.logs[viewId] ?? EMPTY_LOG);
  const apply = useDebugStore((s) => s.apply);
  const [level, setLevel] = useState<Level>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [code, setCode] = useState("");
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const e of log.console) {
      if (e.level === "error") errors += 1;
      else if (e.level === "warn") warnings += 1;
    }
    return { errors, warnings };
  }, [log.console]);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries = log.console.filter((e) => matches(e, level)
      && (!needle || e.text.toLowerCase().includes(needle) || (e.source ?? "").toLowerCase().includes(needle)));
    const shown = entries.slice(-SHOWN);
    const first = shown[0]?.id ?? Number.POSITIVE_INFINITY;
    // De las cargas anteriores al primer mensaje que se ve, solo la última: dice en qué
    // página se logueó sin arrastrar separadores de recargas cuyos mensajes quedaron afuera.
    const before = log.docs.filter((d) => d.id < first);
    const docs = [...before.slice(-1), ...log.docs.filter((d) => d.id > first)];
    return {
      hidden: entries.length - shown.length,
      rows: [
        ...docs.map((d): Row => ({ id: d.id, doc: d })),
        ...shown.map((e): Row => ({ id: e.id, entry: e })),
      ].sort((a, b) => a.id - b.id),
    };
  }, [log.console, log.docs, level, query]);

  // Pegado al final mientras nadie subió a leer: lo nuevo aparece sin que haya que bajar.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    stick.current = true;
  }, [level, query]);

  const run = async () => {
    const source = code.trim();
    if (!source) return;
    history.current = [...history.current.filter((h) => h !== source), source].slice(-50);
    cursor.current = -1;
    setCode("");
    stick.current = true;
    const doc = log.docs[log.docs.length - 1];
    const push = (entry: ConsoleEntry) =>
      apply(viewId, (l) => appendBatch(l, { doc: doc?.doc ?? "panel", url: doc?.url ?? "", console: [entry], network: [] }));
    push({ at: Date.now(), level: "info", kind: "input", text: source });
    try {
      const value = await channel.run({ op: "eval", code: source }, 30_000);
      push({ at: Date.now(), level: "log", kind: "result", text: showValue(value) });
    } catch (e) {
      push({ at: Date.now(), level: "error", kind: "result", text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelToolbar>
        <FilterChip active={level === "all"} onClick={() => setLevel("all")}>{t("browser.debug.console.all")}</FilterChip>
        <FilterChip active={level === "errors"} onClick={() => setLevel("errors")} tone="error">
          {t("browser.debug.console.errors")} {counts.errors > 0 && <span>{counts.errors}</span>}
        </FilterChip>
        <FilterChip active={level === "warnings"} onClick={() => setLevel("warnings")} tone="warn">
          {t("browser.debug.console.warnings")} {counts.warnings > 0 && <span>{counts.warnings}</span>}
        </FilterChip>
        <FilterChip active={level === "logs"} onClick={() => setLevel("logs")}>{t("browser.debug.console.logs")}</FilterChip>
        <div className="flex-1" />
        <SearchField value={query} onChange={setQuery} placeholder={t("browser.debug.filter")} />
        <IconAction label={t("browser.debug.console.clear")} onClick={() => apply(viewId, clearConsole)}>
          <TrashIcon className="w-3.5 h-3.5" />
        </IconAction>
      </PanelToolbar>

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex-1 min-h-0 overflow-y-auto cc-scroll"
      >
        {items.rows.length === 0 ? (
          <Empty>{log.console.length === 0 ? t("browser.debug.console.empty") : t("browser.debug.noMatches")}</Empty>
        ) : (
          <>
            {items.hidden > 0 && (
              <div className="px-3 py-1 text-[10.5px] text-gray-400 dark:text-white/30">
                {t("browser.debug.console.hidden", { n: items.hidden })}
              </div>
            )}
            {items.rows.map((row) => row.doc ? (
              <div key={`d${row.id}`} className="flex items-center gap-2 px-3 pt-2 pb-1 text-[10.5px] text-gray-400 dark:text-white/30">
                <span className="h-px w-3 bg-current opacity-50" />
                <span className="shrink-0 tabular-nums">{formatClock(row.doc.at)}</span>
                <span className="truncate">{t("browser.debug.console.loaded", { url: row.doc.url })}</span>
                <span className="h-px flex-1 bg-current opacity-30" />
              </div>
            ) : row.entry && (
              <ConsoleRow key={row.id} entry={row.entry} open={open.has(row.id)}
                onToggle={() => setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                })} />
            ))}
          </>
        )}
      </div>

      <div className="flex items-start gap-2 shrink-0 px-3 py-1.5 border-t border-gray-200 dark:border-white/7">
        <span className="pt-[3px] font-mono text-[12px] text-blue-600 dark:text-blue-400">›</span>
        <textarea
          value={code}
          rows={Math.min(6, code.split("\n").length)}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run();
            } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !code.includes("\n")) {
              const past = history.current;
              if (past.length === 0) return;
              e.preventDefault();
              const next = e.key === "ArrowUp"
                ? (cursor.current < 0 ? past.length - 1 : Math.max(0, cursor.current - 1))
                : (cursor.current < 0 ? -1 : cursor.current + 1);
              cursor.current = next >= past.length ? -1 : next;
              setCode(cursor.current < 0 ? "" : past[cursor.current]);
            }
          }}
          placeholder={t("browser.debug.console.eval")}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent outline-none font-mono text-[11.5px] leading-[1.5]
            text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/25"
        />
      </div>
    </div>
  );
}

function ConsoleRow({ entry, open, onToggle }: { entry: LoggedConsole; open: boolean; onToggle: () => void }) {
  // Lo que devolvió una evaluación se muestra entero: se pidió justamente para leerlo.
  const clamps = entry.kind !== "result";
  const long = clamps && (entry.text.length > 240 || entry.text.includes("\n") || !!entry.stack);
  const prefix = entry.kind === "exception" ? "Uncaught " : entry.kind === "input" ? "› " : entry.kind === "result" ? "← " : "";
  return (
    <div
      onClick={long ? onToggle : undefined}
      className={`group flex items-start gap-2 pl-0 pr-3 py-[3px] border-b font-mono text-[11.5px] leading-[1.5]
        ${TONE[entry.level] ?? TONE.log} ${long ? "cursor-pointer" : ""}`}
    >
      <span className={`self-stretch w-[3px] shrink-0 ${MARK[entry.level] ?? ""}`} />
      <span className="shrink-0 pt-px text-[10px] tabular-nums text-gray-400 dark:text-white/25">{formatClock(entry.at)}</span>
      <span className={`flex-1 min-w-0 whitespace-pre-wrap break-words ${open || !clamps ? "" : "line-clamp-3"}`}>
        {prefix}{entry.text}
        {open && entry.stack && (
          <span className="block mt-1 text-[10.5px] opacity-70">
            {entry.stack.split("\n").filter((l) => !l.includes("/__controlcode__/")).join("\n")}
          </span>
        )}
      </span>
      {entry.source && (
        <span className="shrink-0 max-w-[38%] truncate pt-px text-[10.5px] text-gray-400 dark:text-white/30" title={entry.source}>
          {entry.source}
        </span>
      )}
    </div>
  );
}
