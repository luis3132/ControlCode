import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, CloudIcon } from "neogestify-ui-components";

import { BranchIcon } from "@/app/icons";

import { scmBranches } from "./ipc";
import type { Branch } from "./types";

/**
 * Qué ramas muestra el grafo:
 * - `current`: la actual y su upstream (lo de siempre, como VS Code);
 * - `all`: todas las locales y remotas;
 * - una lista de refs completas (`refs/heads/x`, `refs/remotes/origin/x`).
 */
export type GraphRefs = "current" | "all" | string[];

const STORAGE_PREFIX = "cc-scm-graph-refs:";

/** La ref completa de una rama tal como la da `scmBranches`. */
export const fullRef = (b: Branch) => (b.remote ? `refs/remotes/${b.name}` : `refs/heads/${b.name}`);

/** Lo que se le pasa a `scmLog`: `null` = la actual y su upstream. */
export function logRefs(refs: GraphRefs): string[] | null {
  if (refs === "all") return ["*"];
  if (refs === "current" || refs.length === 0) return null;
  return refs;
}

export function parseGraphRefs(raw: string | null): GraphRefs {
  if (raw === "all") return "all";
  if (!raw || raw === "current") return "current";
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.every((r) => typeof r === "string") && list.length > 0) return list;
  } catch { /* guardado roto: lo de siempre */ }
  return "current";
}

/**
 * La elección de ramas del grafo, recordada por repo en este equipo. Es una comodidad de
 * vista, como qué paneles están abiertos: no viaja con la sincronización.
 */
export function useGraphRefs(root: string | null): [GraphRefs, (next: GraphRefs) => void] {
  const [refs, setRefs] = useState<GraphRefs>("current");

  useEffect(() => {
    if (!root) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(STORAGE_PREFIX + root); } catch { /* sin storage */ }
    setRefs(parseGraphRefs(raw));
  }, [root]);

  const update = useCallback((next: GraphRefs) => {
    setRefs(next);
    if (!root) return;
    try {
      if (next === "current") localStorage.removeItem(STORAGE_PREFIX + root);
      else localStorage.setItem(STORAGE_PREFIX + root, next === "all" ? "all" : JSON.stringify(next));
    } catch { /* sin storage: vale para esta sesión */ }
  }, [root]);

  return [refs, update];
}

/** El texto corto del botón: "actual", "todas", el nombre de la única elegida o "3 ramas". */
export function useGraphRefsLabel(refs: GraphRefs): string {
  const { t } = useTranslation();
  if (refs === "current") return t("scm.graph.refs.current");
  if (refs === "all") return t("scm.graph.refs.all");
  if (refs.length === 1) return refs[0].replace(/^refs\/(heads|remotes)\//, "");
  return t("scm.graph.refs.count", { count: refs.length });
}

/**
 * Elegir qué ramas se ven en el grafo. Varias a la vez: se dibujan juntas, cada una con sus
 * commits, como en la vista de ramas del host.
 */
export function GraphBranchFilter({ root, value, onChange, onClose }: {
  root: string;
  value: GraphRefs;
  onChange: (next: GraphRefs) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scmBranches(root)
      .then((list) => setBranches(list.filter((b) => !b.name.endsWith("/HEAD"))))
      .catch(() => setBranches([]));
    inputRef.current?.focus();
  }, [root]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const selected = useMemo(() => new Set(Array.isArray(value) ? value : []), [value]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q));
    // Las elegidas arriba, después la actual, después las locales, al final las remotas.
    return list.sort((a, b) =>
      Number(selected.has(fullRef(b))) - Number(selected.has(fullRef(a)))
      || Number(b.current) - Number(a.current)
      || Number(a.remote) - Number(b.remote)
      || b.updatedAt - a.updatedAt);
  }, [branches, query, selected]);

  const toggle = (b: Branch) => {
    const r = fullRef(b);
    const base = Array.isArray(value) ? value : [];
    const next = base.includes(r) ? base.filter((x) => x !== r) : [...base, r];
    onChange(next.length ? next : "current");
  };

  const mode = (key: "current" | "all", label: string, hint: string) => {
    const on = value === key;
    return (
      <button
        onClick={() => onChange(key)}
        className={`flex items-center gap-2 w-full h-8 px-3 text-left hover:bg-gray-100 dark:hover:bg-white/5
          ${on ? "text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"}`}
      >
        <span className={`flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded-full border
          ${on ? "border-blue-500 bg-blue-500" : "border-gray-300 dark:border-white/25"}`}>
          {on && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
        </span>
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-medium">{label}</span>
        <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/30">{hint}</span>
      </button>
    );
  };

  return (
    <div ref={ref}
      className="cc-rise absolute left-2 right-2 bottom-full mb-1 z-30 flex flex-col max-h-96 rounded-xl overflow-hidden
        bg-white dark:bg-[#0d1117] border border-gray-200 dark:border-white/12 shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      }}
    >
      <div className="py-1 border-b border-gray-200 dark:border-white/8">
        {mode("current", t("scm.graph.refs.currentLong"), t("scm.graph.refs.currentHint"))}
        {mode("all", t("scm.graph.refs.allLong"), branches ? String(branches.length) : "")}
      </div>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("scm.graph.refs.search")}
        spellCheck={false}
        className="h-8 shrink-0 px-3 bg-transparent outline-none font-mono text-[11.5px]
          border-b border-gray-200 dark:border-white/8
          text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
      />
      <div className="flex-1 min-h-0 cc-scroll py-1">
        {branches === null ? (
          <p className="px-3 py-3 text-[11px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-gray-400 dark:text-white/30">{t("scm.graph.refs.none")}</p>
        ) : shown.map((b) => {
          const on = selected.has(fullRef(b));
          return (
            <button
              key={fullRef(b)}
              onClick={() => toggle(b)}
              role="menuitemcheckbox"
              aria-checked={on}
              className="flex items-center gap-2 w-full h-7 px-3 text-left hover:bg-gray-100 dark:hover:bg-white/5"
            >
              <span className={`flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded border
                ${on ? "border-blue-500 bg-blue-500 text-white" : "border-gray-300 dark:border-white/25"}`}>
                {on && <CheckIcon className="w-2.5 h-2.5" />}
              </span>
              {b.remote
                ? <CloudIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />
                : <BranchIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />}
              <span className={`flex-1 min-w-0 truncate font-mono text-[11.5px]
                ${b.current ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"}`}>
                {b.name}
              </span>
              {b.current && (
                <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">{t("scm.graph.refs.here")}</span>
              )}
            </button>
          );
        })}
      </div>
      {Array.isArray(value) && (
        <div className="flex items-center gap-2 h-8 px-3 shrink-0 border-t border-gray-200 dark:border-white/8">
          <span className="flex-1 text-[10.5px] text-gray-500 dark:text-white/40">
            {t("scm.graph.refs.count", { count: value.length })}
          </span>
          <button onClick={() => onChange("current")}
            className="text-[10.5px] text-blue-600 dark:text-blue-400 hover:underline">
            {t("scm.graph.refs.reset")}
          </button>
        </div>
      )}
    </div>
  );
}
