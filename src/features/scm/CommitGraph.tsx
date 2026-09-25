import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudIcon, DocumentIcon, Tooltip } from "neogestify-ui-components";

import { BranchIcon, PullIcon, PushIcon, TagIcon } from "@/app/icons";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { graphWidth, layoutGraph, type GraphRow, type Segment } from "./commitGraph";
import { scmCommitFiles } from "./ipc";
import type { Commit, CommitRef, ScmEntry } from "./types";

/** Un color por rama, en el orden en que aparecen. Legibles en los dos temas. */
const PALETTE = ["#3b82f6", "#a855f7", "#f97316", "#10b981", "#ec4899", "#eab308", "#06b6d4", "#ef4444"];
const colorOf = (i: number) => PALETTE[i % PALETTE.length];

const ROW = 24;
const LANE = 11;
const PAD = 8;
/** Más carriles que esto no entran en un panel de 288px sin comerse el mensaje. */
const MAX_LANES = 8;

const x = (lane: number) => PAD + Math.min(lane, MAX_LANES - 1) * LANE;

/** Un tramo de una mitad de la fila: recto si no cambia de carril, curvo si cambia. */
function path(s: Segment, y0: number, y1: number): string {
  const a = x(s.from);
  const b = x(s.to);
  if (a === b) return `M${a} ${y0}L${b} ${y1}`;
  const mid = (y0 + y1) / 2;
  return `M${a} ${y0}C${a} ${mid} ${b} ${mid} ${b} ${y1}`;
}

function GraphCell({ row, width, commit }: { row: GraphRow; width: number; commit: Commit }) {
  const half = ROW / 2;
  const merge = commit.parents.length > 1;
  const head = commit.refs.some((r) => r.kind === "head");
  return (
    <svg width={width} height={ROW} className="shrink-0 overflow-visible" aria-hidden>
      {row.top.map((s, i) => (
        <path key={`t${i}`} d={path(s, 0, half)} stroke={colorOf(s.color)} strokeWidth={1.6} fill="none" />
      ))}
      {row.bottom.map((s, i) => (
        <path key={`b${i}`} d={path(s, half, ROW)} stroke={colorOf(s.color)} strokeWidth={1.6} fill="none" />
      ))}
      {/* Lo que está en el remoto y no acá va hueco: todavía no es de la rama local. */}
      <circle
        cx={x(row.lane)}
        cy={half}
        r={head ? 4.5 : merge ? 3 : 3.6}
        stroke={colorOf(row.color)}
        strokeWidth={head || commit.incoming ? 2 : 1.4}
        className={commit.incoming || head ? "fill-gray-50 dark:fill-[#0a0f16]" : ""}
        fill={commit.incoming || head ? undefined : colorOf(row.color)}
      />
    </svg>
  );
}

const CHIP: Record<CommitRef["kind"], string> = {
  head: "bg-blue-600 text-white dark:bg-blue-500",
  local: "border border-blue-500/50 text-blue-600 dark:text-blue-300",
  remote: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  tag: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

function RefChip({ r }: { r: CommitRef }) {
  const Icon = r.kind === "remote" ? CloudIcon : r.kind === "tag" ? null : BranchIcon;
  return (
    <span title={r.name} className={`inline-flex items-center gap-0.5 min-w-0 shrink max-w-[8rem] h-4 px-1 rounded
      text-[9.5px] font-medium ${CHIP[r.kind]}`}>
      {Icon && <Icon className="w-2.5 h-2.5 shrink-0" />}
      <span className="truncate">{r.name}</span>
    </span>
  );
}

const STATUS_CLASS: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  R: "text-emerald-600 dark:text-emerald-400",
  C: "text-emerald-600 dark:text-emerald-400",
  D: "text-red-500 dark:text-red-400",
  T: "text-amber-600 dark:text-amber-400",
};

/** Las líneas que siguen de largo mientras un commit está desplegado. */
function Continuing({ row, width }: { row: GraphRow; width: number }) {
  return (
    <span className="relative shrink-0 self-stretch" style={{ width }} aria-hidden>
      {row.continuing.filter((c) => c.lane < MAX_LANES).map((c) => (
        <span key={c.lane} className="absolute top-0 bottom-0"
          style={{ left: x(c.lane) - 0.8, width: 1.6, background: colorOf(c.color) }} />
      ))}
    </span>
  );
}

/**
 * El historial con su grafo, como en VS Code: una línea y un color por rama, los chips de
 * cada referencia (la rama actual, las locales, las del remoto, los tags) y, con upstream,
 * lo que falta subir y lo que traería un pull.
 *
 * Un click en un commit despliega los archivos que cambió; uno de ellos abre el diff de ese
 * commit contra su padre.
 */
export function CommitGraph({ cwd, root, commits, onTag }: {
  cwd: string;
  root: string;
  commits: Commit[];
  /** "Crear tag aquí", desde el botón que aparece al pasar sobre un commit. */
  onTag?: (commit: Commit) => void;
}) {
  const { t } = useTranslation();
  const openDiff = useViewTabsStore((s) => s.openDiff);
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = PAD * 2 + (Math.min(graphWidth(rows), MAX_LANES) - 1) * LANE;
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, ScmEntry[] | "error">>({});

  const toggle = (c: Commit) => {
    if (open === c.hash) { setOpen(null); return; }
    setOpen(c.hash);
    if (!files[c.hash]) {
      scmCommitFiles(root, c.hash)
        .then((f) => setFiles((prev) => ({ ...prev, [c.hash]: f })))
        .catch(() => setFiles((prev) => ({ ...prev, [c.hash]: "error" })));
    }
  };

  return (
    <div>
      {commits.map((c, i) => {
        const row = rows[i];
        const isOpen = open === c.hash;
        const list = files[c.hash];
        const tip = `${c.hash}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}\n\n${c.subject}`;
        return (
          <div key={c.hash}>
            <button
              onClick={() => toggle(c)}
              title={tip}
              className={`group flex items-center gap-1.5 w-full pr-3 text-left
                ${isOpen ? "bg-blue-500/10 dark:bg-blue-400/10" : "hover:bg-gray-200/50 dark:hover:bg-white/4"}`}
              style={{ height: ROW }}
            >
              <GraphCell row={row} width={width} commit={c} />
              {/* El mensaje primero y siempre visible; las referencias a su derecha, y son
                  ellas las que se achican cuando no entra todo. */}
              <span className={`flex-1 min-w-[35%] truncate text-[11.5px]
                ${c.incoming ? "text-violet-700/80 dark:text-violet-300/80" : "text-gray-700 dark:text-gray-300"}`}>
                {c.subject}
              </span>
              {c.refs.length > 0 && (
                <span className="flex items-center gap-1 min-w-0 shrink overflow-hidden">
                  {c.refs.map((r) => <RefChip key={`${r.kind}:${r.name}`} r={r} />)}
                </span>
              )}
              {onTag && !c.incoming && (
                <Tooltip content={t("scm.tag.createHere")} placement="left">
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={t("scm.tag.createHere")}
                    onClick={(e) => { e.stopPropagation(); onTag(c); }}
                    className="hidden group-hover:flex items-center justify-center w-5 h-5 shrink-0 rounded
                      text-gray-400 dark:text-white/40 hover:text-amber-600 dark:hover:text-amber-400
                      hover:bg-gray-200 dark:hover:bg-white/10"
                  >
                    <TagIcon className="w-3 h-3" />
                  </span>
                </Tooltip>
              )}
              {c.outgoing && (
                <Tooltip content={t("scm.graph.outgoing")} placement="left">
                  <span><PushIcon className="w-3 h-3 shrink-0 text-blue-500 dark:text-blue-400" /></span>
                </Tooltip>
              )}
              {c.incoming && (
                <Tooltip content={t("scm.graph.incoming")} placement="left">
                  <span><PullIcon className="w-3 h-3 shrink-0 text-violet-500 dark:text-violet-400" /></span>
                </Tooltip>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/30">
                {elapsed(c.time * 1000)}
              </span>
            </button>

            {isOpen && (
              <div className="flex">
                <Continuing row={row} width={width} />
                <div className="flex-1 min-w-0 py-0.5">
                  <div className="px-1 py-0.5 text-[10px] text-gray-400 dark:text-white/35 truncate">
                    <span className="font-mono">{c.short}</span> · {c.author}
                  </div>
                  {list === undefined ? (
                    <p className="px-1 py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("scm.loading")}</p>
                  ) : list === "error" || list.length === 0 ? (
                    <p className="px-1 py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("scm.graph.noFiles")}</p>
                  ) : list.map((f) => {
                    const slash = f.path.lastIndexOf("/");
                    return (
                      <button
                        key={f.path}
                        onClick={() => openDiff(cwd, root, f.path, false, { hash: c.hash, short: c.short, origPath: f.origPath })}
                        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                        className="flex items-center gap-1.5 w-full h-[22px] px-1 pr-3 text-left rounded
                          hover:bg-gray-200/60 dark:hover:bg-white/5"
                      >
                        <DocumentIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/30" />
                        <span className={`shrink-0 max-w-[60%] truncate text-[11px]
                          ${f.status === "D" ? "line-through text-gray-400 dark:text-white/35" : "text-gray-700 dark:text-gray-300"}`}>
                          {f.path.slice(slash + 1)}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-[10px] text-gray-400 dark:text-white/30" dir="rtl">
                          {slash > 0 ? f.path.slice(0, slash) : ""}
                        </span>
                        <span className={`shrink-0 w-3 font-mono text-[10px] text-center ${STATUS_CLASS[f.status] ?? ""}`}>
                          {f.status}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
