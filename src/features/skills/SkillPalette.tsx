import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, CheckIcon, CloudIcon, Skeleton, StackIcon } from "neogestify-ui-components";

import { Markdown } from "@/shared/ui/Markdown";
import { moveSelection, reconcileSelection } from "@/shared/ui/paletteNav";
import { useSkillsStore } from "@/features/skills/store";
import { skillDetail } from "@/features/skills/ipc";
import { useMarketplaceStore } from "@/features/marketplace/store";
import { marketplaceSkillReadme } from "@/features/marketplace/ipc";
import type { SkillSummary } from "@/features/skills/types";
import type { MarketplaceSkillEntry } from "@/features/marketplace/types";

export interface SkillScopeTarget {
  scope: "workspace" | "tab";
  workspaceId: string;
  /** Solo con `scope: "tab"`. */
  tabId?: string;
  /** Solo con `scope: "workspace"`: la carpeta a la que aplica. */
  cwd?: string;
  /** Para filtrar el catálogo por TUI. `null` en alcance de workspace. */
  agentId: string | null;
  label: string;
}

/** Una fila de la lista, venga del catálogo instalado o del marketplace. */
type Row =
  | { kind: "installed"; key: string; skill: SkillSummary; attached: boolean }
  | { kind: "remote"; key: string; entry: MarketplaceSkillEntry };

const keyOfInstalled = (s: SkillSummary) => `i:${s.id}`;
const keyOfRemote = (e: MarketplaceSkillEntry) => `m:${e.registryId}:${e.id}`;

/** Las que YA están adjuntas en este alcance, según `usedBy`. */
function isAttached(skill: SkillSummary, target: SkillScopeTarget): boolean {
  return skill.usedBy.some((use) =>
    target.scope === "tab"
      ? use.scope === "tab" && use.tabId === target.tabId
      : use.scope === "workspace"
        && use.workspaceId === target.workspaceId
        && use.cwd === (target.cwd ?? "")
  );
}

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.filter(Boolean).join(" ").toLowerCase().includes(q);
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pt-3 pb-1">
      <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
        text-gray-400 dark:text-white/30">
        {label}
      </span>
      <span className="flex-1 h-px bg-gray-200 dark:bg-white/6" />
    </div>
  );
}

/**
 * Elegir las skills de un alcance, con la misma paleta que el buscador del marketplace.
 *
 * Se llega por click derecho sobre un workspace o sobre un agente del panel izquierdo, y
 * el alcance que se tocó es el que viene marcado. `⇥` lo cambia sin cerrar: adjuntar al
 * agente y adjuntar a toda la carpeta son la misma decisión tomada a distinta altura, y
 * obligar a cerrar y volver a abrir para cambiarla es puro trámite.
 *
 * Lo de arriba son las instaladas; abajo, lo que hay en los repositorios. Enter adjunta —
 * o instala y adjunta, si todavía no está — y vuelve a apretarlo la quita.
 */
export function SkillPalette({ target: initial, onClose }: {
  target: SkillScopeTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const skills = useSkillsStore((s) => s.skills);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const attachSkill = useSkillsStore((s) => s.attachSkill);
  const detachSkill = useSkillsStore((s) => s.detachSkill);
  const remote = useMarketplaceStore((s) => s.skills);
  const loadRemote = useMarketplaceStore((s) => s.loadSkills);
  const searchRemote = useMarketplaceStore((s) => s.searchRemote);
  const installFromMarketplace = useMarketplaceStore((s) => s.installSkill);

  // El alcance se puede cambiar sin cerrar, pero solo si hay una tab a la que apuntar.
  const [scope, setScope] = useState(initial.scope);
  const target: SkillScopeTarget = { ...initial, scope };
  const canSwapScope = Boolean(initial.tabId);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadSkills(); loadRemote(); inputRef.current?.focus(); }, [loadSkills, loadRemote]);

  // El marketplace se consulta con espera: cada disparo puede levantar un proceso.
  useEffect(() => {
    const handle = setTimeout(() => searchRemote(query), 700);
    return () => clearTimeout(handle);
  }, [query, searchRemote]);

  const installed = useMemo(() => {
    const compatible = target.agentId === null
      ? skills
      : skills.filter((s) => s.compatibleAgents.length === 0 || s.compatibleAgents.includes(target.agentId!));
    return compatible
      .filter((s) => matches(query, s.name, s.description, s.categories.join(" ")))
      // Las adjuntas primero: son las que hay que poder repasar de un vistazo.
      .sort((a, b) => Number(isAttached(b, target)) - Number(isAttached(a, target)));
  }, [skills, query, target]);

  const installedOrigins = useMemo(
    () => new Set(skills.filter((s) => s.registryId && s.originSkillId)
      .map((s) => `${s.registryId}:${s.originSkillId}`)),
    [skills]
  );

  const available = useMemo(
    () => remote.filter((e) => !installedOrigins.has(`${e.registryId}:${e.id}`)),
    [remote, installedOrigins]
  );

  const rows: Row[] = useMemo(() => [
    ...installed.map((skill): Row => ({
      kind: "installed", key: keyOfInstalled(skill), skill, attached: isAttached(skill, target),
    })),
    ...available.map((entry): Row => ({ kind: "remote", key: keyOfRemote(entry), entry })),
  ], [installed, available, target]);

  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  useEffect(() => { setSelected((current) => reconcileSelection(keys, current)); }, [keys]);

  const current = rows.find((r) => r.key === selected) ?? null;

  const apply = useCallback(async (row: Row) => {
    setBusy(true);
    setError(null);
    try {
      if (row.kind === "remote") {
        const installedSkill = await installFromMarketplace(row.entry.registryId, row.entry.id);
        await attachSkill(installedSkill.id, target.workspaceId, target.scope, target.tabId, target.cwd);
      } else if (row.attached) {
        await detachSkill(row.skill.id, target.workspaceId, target.scope, target.tabId, target.cwd);
      } else {
        await attachSkill(row.skill.id, target.workspaceId, target.scope, target.tabId, target.cwd);
      }
      await loadSkills();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [attachSkill, detachSkill, installFromMarketplace, loadSkills, target]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((c) => moveSelection(keys, c, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Tab" && canSwapScope) {
      e.preventDefault();
      setScope((s) => (s === "tab" ? "workspace" : "tab"));
    } else if (e.key === "Enter" && current && !busy) {
      e.preventDefault();
      apply(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const firstRemote = rows.findIndex((r) => r.kind === "remote");

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-8">
      <button
        onClick={onClose}
        aria-label={t("btn.close")}
        className="cc-fade absolute inset-0 bg-gray-900/45 dark:bg-black/65"
      />

      <div className="cc-rise relative flex w-full max-w-4xl h-[30rem]
        rounded-2xl overflow-hidden
        bg-white dark:bg-gray-900
        border border-gray-200 dark:border-white/12 shadow-2xl">

        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex items-center gap-3 h-[54px] shrink-0 px-4
            border-b border-gray-200 dark:border-white/8">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              className="shrink-0 text-blue-500 dark:text-blue-400">
              <path d="M5 7l5 5-5 5M13 17h6" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("skills.palette.search")}
              className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[15px]
                text-gray-900 dark:text-white
                placeholder:text-gray-400 dark:placeholder:text-white/25"
            />
            <Badge variant="accent" size="sm" className="shrink-0">
              {scope === "tab"
                ? t("skills.palette.scopeTab", { name: initial.label })
                : t("skills.palette.scopeWorkspace", { name: initial.label })}
            </Badge>
          </div>

          <div className="flex-1 min-h-0 cc-scroll py-1.5">
            {error && <div className="px-3 pb-2"><Alert variant="danger">{error}</Alert></div>}

            {rows.length === 0 ? (
              <p className="px-4 py-10 text-center text-[11.5px] text-gray-400 dark:text-white/30">
                {t("skills.palette.empty")}
              </p>
            ) : (
              rows.map((row, i) => (
                <div key={row.key}>
                  {/* Sin instaladas, la fila 0 es ya del marketplace: ahí no va el
                      encabezado de "Adjuntar", que quedaría encima de una sección vacía. */}
                  {i === 0 && row.kind === "installed" && (
                    <GroupHeader label={t("skills.palette.attach")} />
                  )}
                  {i === firstRemote && (
                    <GroupHeader label={t("skills.palette.install")} />
                  )}
                  <div
                    onClick={() => setSelected(row.key)}
                    onDoubleClick={() => !busy && apply(row)}
                    className={`cc-t flex items-center gap-3 h-[42px] mx-1.5 px-2.5 rounded-lg cursor-pointer
                      ${row.key === selected
                        ? "bg-blue-500/12 dark:bg-blue-400/13 shadow-[inset_0_0_0_1px_rgba(88,166,255,0.24)]"
                        : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
                  >
                    <span className={`flex items-center justify-center w-6 h-6 rounded-md shrink-0
                      ${row.kind === "installed" && row.attached
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-violet-500/12 text-violet-500 dark:text-violet-400"}`}>
                      {row.kind === "remote"
                        ? <CloudIcon className="w-3.5 h-3.5" />
                        : row.attached
                          ? <CheckIcon className="w-3.5 h-3.5" />
                          : <StackIcon className="w-3.5 h-3.5" />}
                    </span>

                    <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span className="text-[12.5px] font-semibold truncate text-gray-800 dark:text-gray-200">
                        {row.kind === "installed" ? row.skill.name : row.entry.name}
                      </span>
                      <span className="text-[10.5px] font-mono truncate text-gray-400 dark:text-white/35">
                        {row.kind === "installed"
                          ? [t("skills.palette.installedTag"), row.skill.registryName ?? t("skills.palette.local")]
                              .filter(Boolean).join(" · ")
                          : [row.entry.author, row.entry.registryName].filter(Boolean).join(" · ")}
                      </span>
                    </span>

                    {row.kind === "installed" && row.attached && (
                      <Badge variant="success" size="sm" className="shrink-0">
                        {t("skills.palette.attached")}
                      </Badge>
                    )}
                    {row.key === selected && (
                      <span className="shrink-0 flex items-center h-5 px-1.5 rounded border text-[10px] font-mono
                        border-gray-300 dark:border-white/15 text-gray-500 dark:text-gray-400">
                        ↵
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
            border-t border-gray-200 dark:border-white/8
            bg-gray-100/60 dark:bg-black/20
            text-[10.5px] text-gray-400 dark:text-white/35">
            <span><b className="text-gray-500 dark:text-gray-400">↵</b>{" "}
              {current?.kind === "installed" && current.attached
                ? t("skills.palette.key.detach")
                : t("skills.palette.key.attach")}
            </span>
            {canSwapScope && (
              <span><b className="text-gray-500 dark:text-gray-400">⇥</b> {t("skills.palette.key.scope")}</span>
            )}
            <div className="flex-1" />
            <span><b className="text-gray-500 dark:text-gray-400">esc</b> {t("skills.palette.key.close")}</span>
          </div>
        </div>

        <SkillPreview row={current} scopeDir={target.cwd ?? null} />
      </div>
    </div>
  );
}

/** La columna derecha: el SKILL.md de lo que esté marcado, renderizado. */
function SkillPreview({ row, scopeDir }: { row: Row | null; scopeDir: string | null }) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!row) { setContent(null); return; }
    let stale = false;
    setContent(null);
    setLoading(true);

    const read = row.kind === "installed"
      ? skillDetail(row.skill.id).then((d) => d.content)
      : marketplaceSkillReadme(row.entry.registryId, row.entry.id);

    read
      .then((c) => { if (!stale) setContent(c); })
      .catch(() => { if (!stale) setContent(null); })
      .finally(() => { if (!stale) setLoading(false); });

    return () => { stale = true; };
  }, [row]);

  return (
    <aside className="flex flex-col w-[21rem] shrink-0 min-h-0
      border-l border-gray-200 dark:border-white/8
      bg-gray-100/50 dark:bg-black/20">
      {!row ? (
        <p className="px-5 py-8 text-[11.5px] text-center text-gray-400 dark:text-white/30">
          {t("skills.palette.pick")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1 shrink-0 px-5 pt-5 pb-3">
            <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">
              {row.kind === "installed" ? row.skill.name : row.entry.name}
            </span>
            <span className="text-[10.5px] font-mono text-gray-400 dark:text-white/35">
              {row.kind === "installed"
                ? [row.skill.author, row.skill.version, row.skill.registryName ?? t("skills.palette.local")]
                    .filter(Boolean).join(" · ")
                : [row.entry.author, row.entry.registryName].filter(Boolean).join(" · ")}
            </span>
          </div>

          <div className="flex-1 min-h-0 cc-scroll px-5 pb-4">
            {loading ? (
              <Skeleton variant="text" lines={8} />
            ) : content ? (
              <Markdown content={content} />
            ) : (
              <p className="text-[12.5px] text-gray-500 dark:text-gray-400">
                {(row.kind === "remote" ? row.entry.description : row.skill.description)
                  ?? t("skills.palette.noDescription")}
              </p>
            )}
          </div>

          {/* Qué pasa exactamente al adjuntar. Es lo que hace que la decisión no dé miedo. */}
          <div className="shrink-0 m-4 mt-0 p-3 rounded-lg text-[10.5px] leading-relaxed
            bg-emerald-500/7 border border-emerald-500/25
            text-emerald-700 dark:text-emerald-300">
            {scopeDir
              ? t("skills.palette.note", { dir: scopeDir })
              : t("skills.palette.noteTab")}
          </div>
        </>
      )}
    </aside>
  );
}
