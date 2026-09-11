import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AddIcon,
  Alert,
  Badge,
  Button,
  CloudIcon,
  CopyIcon,
  EditIcon,
  EmptyState,
  FolderIcon,
  InfoIcon,
  Kbd,
  StackIcon,
  Tooltip,
  TrashIcon,
} from "neogestify-ui-components";

import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";
import { useTabsStore } from "@/features/tabs/store";
import { InstallSkillDialog } from "@/features/skills/InstallSkillDialog";
import { DeleteSkillDialog } from "@/features/skills/DeleteSkillDialog";
import { AttachSkillDialog } from "@/features/skills/AttachSkillDialog";
import { SkillBuilderDialog } from "@/features/skills/SkillBuilderDialog";
import {
  filterSkills,
  flatSkillOrder,
  groupSkillsByOrigin,
} from "@/features/skills/skillGroups";
import { moveSelection, reconcileSelection, useSelectionVisible } from "@/shared/ui/paletteNav";

/** Una skill instalada, como fila de la paleta. */
function SkillRow({ skill, selected, rowRef, onSelect, onOpen }: {
  skill: SkillSummary;
  selected: boolean;
  /** Solo lo recibe la fila MARCADA, para poder traerla a la vista con las flechas. */
  rowRef?: React.RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={rowRef}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`cc-t flex items-center gap-3 h-[42px] mx-1.5 px-2.5 rounded-lg cursor-pointer
        ${selected
          ? "bg-blue-500/12 dark:bg-blue-400/13 shadow-[inset_0_0_0_1px_rgba(88,166,255,0.24)]"
          : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
    >
      <span className="flex items-center justify-center w-6 h-6 rounded-md shrink-0
        bg-violet-500/12 text-violet-500 dark:text-violet-400">
        <StackIcon className="w-3.5 h-3.5" />
      </span>

      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
          {skill.name}
        </span>
        <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
          {skill.description ?? t("skills.list.noDescription")}
        </span>
      </span>

      <span className="shrink-0 font-mono text-[10px] text-gray-400 dark:text-white/30">
        v{skill.version}
      </span>
      {/* En cuántos lugares está montada. Es el dato por el que se entra a esta pantalla:
          lo que nadie usa es lo que se puede borrar. */}
      <span className={`shrink-0 w-8 text-right text-[10px] tabular-nums
        ${skill.usedBy.length > 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-gray-300 dark:text-white/20"}`}>
        {skill.usedBy.length > 0 ? `×${skill.usedBy.length}` : "—"}
      </span>
    </div>
  );
}

export function SkillsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const skills = useSkillsStore((s) => s.skills);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const detachSkill = useSkillsStore((s) => s.detachSkill);
  const checkHealth = useSkillsStore((s) => s.checkHealth);
  const brokenSymlinks = useSkillsStore((s) => s.brokenSymlinks);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const [installOpen, setInstallOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const [attachTarget, setAttachTarget] = useState<SkillSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSkills();
    checkHealth(workspaceId).catch(() => {});
  }, [loadSkills, checkHealth, workspaceId]);

  const groups = useMemo(
    () => groupSkillsByOrigin(filterSkills(skills, query)),
    [skills, query]
  );
  const order = useMemo(() => flatSkillOrder(groups), [groups]);

  useEffect(() => {
    setSelectedId((current) => reconcileSelection(order.map((s) => s.id), current));
  }, [order]);

  const selected = order.find((s) => s.id === selectedId) ?? null;
  const selectedRef = useSelectionVisible<HTMLDivElement>(selectedId);

  // El foco arranca en el buscador: esto es una paleta, se llega escribiendo.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleDetach = async (
    skill: SkillSummary,
    wsId: string,
    scope: "workspace" | "tab",
    tabId?: string | null,
    cwd?: string
  ) => {
    try {
      await detachSkill(skill.id, wsId, scope, tabId ?? undefined, cwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedId((current) =>
        moveSelection(order.map((s) => s.id), current, e.key === "ArrowDown" ? 1 : -1)
      );
      return;
    }
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      navigate(`/skills/${selected.id}`);
    }
  };

  return (
    <div className="flex h-full min-h-0">

      {/* ══ la lista ══════════════════════════════════════════════════════ */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center gap-3 h-[54px] shrink-0 pl-4 pr-14
          border-b border-gray-200 dark:border-white/8">
          <StackIcon className="w-[15px] h-[15px] shrink-0 text-violet-500 dark:text-violet-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("skills.searchPlaceholder")}
            className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[15px]
              text-gray-900 dark:text-white
              placeholder:text-gray-400 dark:placeholder:text-white/25"
          />
          {/* Crear la propia va PRIMERO y en secundario: instalar es lo más frecuente,
              pero escribir una skill es lo que la mayoría no descubre que puede hacer. */}
          <Tooltip content={t("skills.builder.new")} placement="bottom">
            <button
              onClick={() => setBuilderOpen(true)}
              aria-label={t("skills.builder.new")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                text-gray-400 dark:text-white/35
                hover:text-gray-700 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10"
            >
              <EditIcon className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
          <Tooltip content={t("skills.install.btn")} placement="bottom">
            <button
              onClick={() => setInstallOpen(true)}
              aria-label={t("skills.install.btn")}
              className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
                text-gray-400 dark:text-white/35
                hover:text-gray-700 dark:hover:text-white
                hover:bg-gray-200 dark:hover:bg-white/10"
            >
              <AddIcon className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>

        <div className="flex-1 min-h-0 cc-scroll py-1.5">
          {error && <div className="px-3 pb-2"><Alert variant="danger">{error}</Alert></div>}

          {/* Los symlinks rotos van arriba de todo: mientras uno esté roto, la skill no
              llega al agente aunque la lista la muestre como instalada. */}
          {brokenSymlinks.length > 0 && (
            <div className="mx-3 mb-2 rounded-lg overflow-hidden
              border border-amber-300/70 dark:border-amber-500/25
              bg-amber-50 dark:bg-amber-500/8">
              <div className="flex items-center gap-2 px-3 h-7
                border-b border-amber-200/70 dark:border-amber-500/15">
                <InfoIcon className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-[10.5px] font-bold uppercase tracking-[0.09em]
                  text-amber-700 dark:text-amber-400">
                  {t("skills.health.title")}
                </span>
              </div>
              {brokenSymlinks.map((issue) => {
                // Por id: con dos instaladas del mismo nombre, buscar por nombre linkeaba el
                // aviso a la que apareciera primero — y los botones actuaban sobre esa.
                const skill = skills.find((s) => s.id === issue.skillId);
                const usage = skill?.usedBy.find((u) => u.tabId === issue.tabId);
                return (
                  <div
                    key={`${issue.skillId}:${issue.tabId}`}
                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono
                      text-amber-800 dark:text-amber-300/90"
                  >
                    <span className="flex-1 min-w-0 truncate">
                      {issue.skillName} — {issue.tabTitle ?? issue.tabId}
                      {" ("}
                      {t(`skills.health.${issue.issue === "stale_target" ? "staleTarget" : issue.issue}`)}
                      {")"}
                    </span>
                    {skill && usage && (
                      <span className="flex gap-1 shrink-0">
                        <button
                          onClick={() => useSkillsStore.getState()
                            .attachSkill(skill.id, usage.workspaceId, usage.scope, usage.tabId ?? undefined, usage.cwd)
                            .then(() => checkHealth(workspaceId))}
                          className="cc-t px-1.5 h-5 rounded text-[10px] font-sans
                            bg-amber-200/60 dark:bg-amber-500/15
                            hover:bg-amber-300/70 dark:hover:bg-amber-500/25"
                        >
                          {t("skills.health.repair")}
                        </button>
                        <button
                          onClick={() => useSkillsStore.getState()
                            .detachSkill(skill.id, usage.workspaceId, usage.scope, usage.tabId ?? undefined, usage.cwd)
                            .then(() => checkHealth(workspaceId))}
                          className="cc-t px-1.5 h-5 rounded text-[10px] font-sans
                            bg-amber-200/60 dark:bg-amber-500/15
                            hover:bg-amber-300/70 dark:hover:bg-amber-500/25"
                        >
                          {t("skills.health.remove")}
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {skills.length === 0 ? (
            <EmptyState
              className="py-14"
              icon={<StackIcon className="w-8 h-8" />}
              title={t("skills.list.empty")}
              action={
                <Button variant="primary" size="sm" onClick={() => setInstallOpen(true)}>
                  {t("skills.install.btn")}
                </Button>
              }
            />
          ) : order.length === 0 ? (
            <EmptyState
              className="py-14"
              icon={<StackIcon className="w-8 h-8" />}
              title={t("skills.searchEmpty")}
              action={
                <button
                  onClick={() => setQuery("")}
                  className="cc-t text-[11.5px] text-blue-500 dark:text-blue-400 hover:underline"
                >
                  {t("sessions.filters.clear")}
                </button>
              }
            />
          ) : (
            groups.map((group) => (
              <div key={group.registryId ?? "local"}>
                <div className="flex items-center gap-2.5 px-4 pt-3 pb-1">
                  {group.registryId
                    ? <CloudIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/25" />
                    : <FolderIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/25" />}
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                    text-gray-400 dark:text-white/30">
                    {group.registryName ?? t("skills.list.localOrigin")}
                  </span>
                  <span className="flex-1 h-px bg-gray-200 dark:bg-white/6" />
                  <span className="text-[9.5px] tabular-nums text-gray-400 dark:text-white/25">
                    {group.items.length}
                  </span>
                </div>
                {group.items.map((skill) => (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    selected={skill.id === selectedId}
                    rowRef={skill.id === selectedId ? selectedRef : undefined}
                    onSelect={() => setSelectedId(skill.id)}
                    onOpen={() => navigate(`/skills/${skill.id}`)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 h-[34px] shrink-0 px-4
          border-t border-gray-200 dark:border-white/8
          bg-gray-100/60 dark:bg-black/20
          text-[10.5px] text-gray-400 dark:text-white/35">
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> {t("skills.key.open")}</span>
          <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd> {t("sessions.key.move")}</span>
          <div className="flex-1" />
          <span className="tabular-nums">{t("skills.key.total", { n: skills.length })}</span>
        </div>
      </div>

      {/* ══ la skill elegida ══════════════════════════════════════════════ */}
      <aside className="flex flex-col w-[21rem] shrink-0 min-h-0
        border-l border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/20">
        {!selected ? (
          <p className="px-5 py-8 text-[11.5px] text-center text-gray-400 dark:text-white/30">
            {t("skills.preview.none")}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1 shrink-0 px-5 pt-5 pb-3">
              <span className="text-[13.5px] font-bold text-gray-900 dark:text-white">
                {selected.name}
              </span>
              <span className="text-[10.5px] font-mono text-gray-400 dark:text-white/35">
                {[`v${selected.version}`, selected.author, selected.registryName ?? t("skills.list.localOrigin")]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {selected.categories.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selected.categories.map((c) => (
                    <Badge key={c} variant="neutral" size="sm">{c}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 cc-scroll px-5 pb-4">
              <p className="text-[12.5px] leading-relaxed text-gray-600 dark:text-gray-400">
                {selected.description ?? t("skills.list.noDescription")}
              </p>

              <div className="mt-5">
                <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
                  text-gray-400 dark:text-white/30">
                  {t("skills.list.usedByTitle", { n: selected.usedBy.length })}
                </span>
                {selected.usedBy.length === 0 ? (
                  <p className="mt-1.5 text-[11.5px] text-gray-400 dark:text-white/30">
                    {t("skills.list.notAttached")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1 mt-1.5">
                    {selected.usedBy.map((u, i) => (
                      <div
                        key={i}
                        className="cc-t group flex items-center gap-1.5 px-2 h-7 rounded-md
                          bg-white dark:bg-white/5
                          hover:bg-gray-50 dark:hover:bg-white/8"
                      >
                        <span className="flex-1 min-w-0 truncate text-[11px] font-mono
                          text-gray-600 dark:text-gray-400">
                          {u.scope === "tab"
                            ? (u.tabTitle ?? u.tabId)
                            : (u.cwd || u.workspaceName)}
                        </span>
                        <Badge variant="neutral" size="sm" className="shrink-0">
                          {u.scope === "tab"
                            ? t("skills.attach.scopeTab")
                            : t("skills.attach.scopeWorkspace")}
                        </Badge>
                        <Tooltip content={t("skills.list.detach")} placement="left">
                          <button
                            onClick={() => handleDetach(selected, u.workspaceId, u.scope, u.tabId, u.cwd)}
                            aria-label={t("skills.list.detach")}
                            className="cc-t flex items-center justify-center w-5 h-5 rounded shrink-0
                              opacity-0 group-hover:opacity-100
                              text-gray-400 dark:text-white/35
                              hover:text-red-500 dark:hover:text-red-400
                              hover:bg-gray-200 dark:hover:bg-white/10"
                          >
                            <TrashIcon className="w-3 h-3" />
                          </button>
                        </Tooltip>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0 px-5 py-3
              border-t border-gray-200 dark:border-white/8">
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                onClick={() => setAttachTarget(selected)}
              >
                <CopyIcon className="w-3.5 h-3.5" />
                {t("skills.attach.action")}
              </Button>
              <Tooltip content={t("skills.detail.title")} placement="top">
                <button
                  onClick={() => navigate(`/skills/${selected.id}`)}
                  aria-label={t("skills.detail.title")}
                  className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
                    text-gray-400 dark:text-white/35
                    hover:text-gray-700 dark:hover:text-white
                    hover:bg-gray-200 dark:hover:bg-white/10"
                >
                  <EditIcon className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
              <Tooltip content={t("skills.delete.confirm")} placement="top">
                <button
                  onClick={() => setDeleteTarget(selected)}
                  aria-label={t("skills.delete.confirm")}
                  className="cc-t flex items-center justify-center w-7 h-7 rounded-md shrink-0
                    text-gray-400 dark:text-white/35
                    hover:text-red-500 dark:hover:text-red-400
                    hover:bg-gray-200 dark:hover:bg-white/10"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </aside>

      {builderOpen && (
        <SkillBuilderDialog
          onClose={() => setBuilderOpen(false)}
          onCreated={(skill) => {
            setBuilderOpen(false);
            // Se abre en el detalle: recién creada, lo siguiente es escribirla.
            navigate(`/skills/${skill.id}`);
          }}
        />
      )}
      {installOpen && <InstallSkillDialog onClose={() => setInstallOpen(false)} />}
      {deleteTarget && <DeleteSkillDialog skill={deleteTarget} onClose={() => setDeleteTarget(null)} />}
      {attachTarget && <AttachSkillDialog skill={attachTarget} onClose={() => setAttachTarget(null)} />}
    </div>
  );
}
