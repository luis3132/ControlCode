import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddIcon, CheckIcon, CloudIcon } from "neogestify-ui-components";

import { BranchIcon } from "@/app/icons";

import { scmBranches } from "./ipc";
import type { Branch } from "./types";

/**
 * Cambiar de rama o crear una, desde la franja del panel.
 *
 * Un solo campo hace las dos cosas: filtra las ramas mientras se escribe y, si lo escrito
 * no es ninguna, ofrece crearla. Es lo que se hace casi siempre ("ir a main", "abrir
 * feat/x") sin tener que elegir antes entre dos botones.
 */
export function BranchMenu({ root, onPick, onClose }: {
  root: string;
  onPick: (name: string, create: boolean, remote: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scmBranches(root).then(setBranches).catch(() => setBranches([]));
    inputRef.current?.focus();
  }, [root]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const name = query.trim();
  const shown = useMemo(() => {
    const q = name.toLowerCase();
    return (branches ?? []).filter((b) => b.name.toLowerCase().includes(q)).slice(0, 60);
  }, [branches, name]);
  const exact = (branches ?? []).some((b) => !b.remote && b.name === name);
  const canCreate = name.length > 0 && !exact;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && name) {
      e.preventDefault();
      const match = shown.find((b) => b.name === name) ?? (shown.length === 1 ? shown[0] : undefined);
      if (match) onPick(match.name, false, match.remote);
      else onPick(name, true, false);
    }
  };

  return (
    <div ref={ref}
      className="cc-rise absolute left-2 right-2 top-9 z-30 flex flex-col max-h-80 rounded-xl overflow-hidden
        bg-white dark:bg-[#0d1117] border border-gray-200 dark:border-white/12 shadow-2xl">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("scm.branch.search")}
        spellCheck={false}
        className="h-9 shrink-0 px-3 bg-transparent outline-none font-mono text-[12px]
          border-b border-gray-200 dark:border-white/8
          text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
      />
      <div className="flex-1 min-h-0 cc-scroll py-1">
        {canCreate && (
          <button
            onClick={() => onPick(name, true, false)}
            className="flex items-center gap-2 w-full h-7 px-3 text-left hover:bg-gray-100 dark:hover:bg-white/5"
          >
            <AddIcon className="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
            <span className="truncate text-[11.5px] text-gray-700 dark:text-gray-300">
              {t("scm.branch.create", { name })}
            </span>
          </button>
        )}
        {branches === null ? (
          <p className="px-3 py-3 text-[11px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
        ) : shown.map((b) => (
          <button
            key={`${b.remote ? "r" : "l"}:${b.name}`}
            onClick={() => onPick(b.name, false, b.remote)}
            disabled={b.current}
            className="flex items-center gap-2 w-full h-7 px-3 text-left
              hover:bg-gray-100 dark:hover:bg-white/5 disabled:hover:bg-transparent"
          >
            {b.current
              ? <CheckIcon className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
              : b.remote
                ? <CloudIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />
                : <BranchIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />}
            <span className={`flex-1 min-w-0 truncate font-mono text-[11.5px]
              ${b.current ? "font-semibold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-300"}`}>
              {b.name}
            </span>
            {b.upstream && !b.remote && (
              <span className="shrink-0 max-w-24 truncate font-mono text-[10px] text-gray-400 dark:text-white/25">
                {b.upstream}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
