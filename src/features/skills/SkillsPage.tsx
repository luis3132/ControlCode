import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Input } from "neogestify-ui-components";
import { AddIcon, EditIcon, TrashIcon, ChevronDownIcon, CopyIcon, SearchIcon, StackIcon, InfoIcon, CloudIcon, FolderIcon } from "neogestify-ui-components";
import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";
import { useTabsStore } from "@/features/tabs/store";
import { InstallSkillDialog } from "@/features/skills/InstallSkillDialog";
import { DeleteSkillDialog } from "@/features/skills/DeleteSkillDialog";
import { AttachSkillDialog } from "@/features/skills/AttachSkillDialog";
import { PageHeader } from "@/shared/ui/PageHeader";

export function SkillsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const skills = useSkillsStore((s) => s.skills);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const detachSkill = useSkillsStore((s) => s.detachSkill);
  const checkHealth = useSkillsStore((s) => s.checkHealth);
  const brokenSymlinks = useSkillsStore((s) => s.brokenSymlinks);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const [attachTarget, setAttachTarget] = useState<SkillSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadSkills();
    checkHealth(workspaceId).catch(() => {});
  }, [loadSkills, checkHealth, workspaceId]);

  const handleDetach = async (skill: SkillSummary, workspaceId: string, scope: "workspace" | "tab", tabId?: string | null) => {
    try {
      await detachSkill(skill.id, workspaceId, scope, tabId ?? undefined);
    } catch (e) {
      setError(String(e));
    }
  };

  const filtered = skills.filter((s) => {
    if (!query.trim()) return true;
    // El repo entra en la búsqueda: con skills homónimas de repos distintos, filtrar por
    // "anthropics" es la forma natural de quedarse con la que buscabas.
    const haystack = `${s.name} ${s.description ?? ""} ${s.categories.join(" ")} ${s.registryName ?? ""} ${s.author ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto">

        <PageHeader
          icon={<StackIcon className="w-5 h-5" />}
          title={t("skills.manage.title")}
          subtitle={t("skills.manage.subtitle")}
          action={
            <Button variant="primary" onClick={() => setInstallOpen(true)} className="flex items-center gap-1.5 !text-sm w-fit">
              <AddIcon className="w-4 h-4" />
              {t("skills.install.btn")}
            </Button>
          }
        />

        {error && <p className="text-sm text-red-500 dark:text-red-400 mb-4 px-1">{error}</p>}

        {brokenSymlinks.length > 0 && (
          <div className="mb-6 rounded-xl border border-amber-300 dark:border-amber-700
            bg-amber-50 dark:bg-amber-500/10 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-200 dark:border-amber-700/50">
              <InfoIcon className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                {t("skills.health.title")}
              </p>
            </div>
            <ul className="flex flex-col divide-y divide-amber-200/60 dark:divide-amber-700/30">
              {brokenSymlinks.map((issue) => {
                // Por id: con dos instaladas del mismo nombre, buscar por nombre linkeaba el
                // aviso a la que apareciera primero — y los botones actuaban sobre esa.
                const skill = skills.find((s) => s.id === issue.skillId);
                const usage = skill?.usedBy.find((u) => u.tabId === issue.tabId);
                return (
                  <li key={`${issue.skillId}:${issue.tabId}`} className="flex items-center justify-between gap-2 px-4 py-2 text-xs font-mono text-amber-800 dark:text-amber-300">
                    <span className="truncate">
                      {issue.skillName} — {issue.tabTitle ?? issue.tabId} ({t(`skills.health.${issue.issue === "stale_target" ? "staleTarget" : issue.issue}`)})
                    </span>
                    {skill && usage && (
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="outline"
                          onClick={() => useSkillsStore.getState().attachSkill(skill.id, usage.workspaceId, usage.scope, usage.tabId ?? undefined).then(() => checkHealth(workspaceId))}
                          className="!text-[10px] !px-2 !py-0.5"
                        >
                          {t("skills.health.repair")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => useSkillsStore.getState().detachSkill(skill.id, usage.workspaceId, usage.scope, usage.tabId ?? undefined).then(() => checkHealth(workspaceId))}
                          className="!text-[10px] !px-2 !py-0.5"
                        >
                          {t("skills.health.remove")}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {skills.length > 0 && (
          <div className="mb-4">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("skills.searchPlaceholder")}
              variant="outline"
              icon={<SearchIcon className="w-4 h-4" />}
              clearable
              onClear={() => setQuery("")}
            />
          </div>
        )}

        {skills.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-gray-400 dark:text-gray-500">
            <StackIcon className="w-8 h-8 opacity-30" />
            <p className="text-sm">{t("skills.list.empty")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm italic text-gray-400 dark:text-gray-500 text-center py-8">
            {t("skills.searchEmpty")}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
            {filtered.map((skill) => {
              const expanded = expandedId === skill.id;
              return (
                <div
                  key={skill.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-700
                    bg-white dark:bg-gray-800/50
                    hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm
                    transition-all"
                >
                  <div className="flex items-start gap-3 px-4 py-3">
                    <span className="flex items-center justify-center w-9 h-9 rounded-full shrink-0
                      bg-blue-50 dark:bg-blue-500/10 text-blue-500 dark:text-blue-400">
                      <StackIcon className="w-4 h-4" />
                    </span>
                    <button
                      onClick={() => navigate(`/skills/${skill.id}`)}
                      className="flex flex-col min-w-0 text-left flex-1"
                    >
                      {/* El nombre en su propia línea y los badges en una fila que envuelve
                          abajo. Antes iban todos como hermanos dentro de un flex con
                          `truncate`: como `{skill.name}` es un nodo de texto suelto, no podía
                          encogerse, tomaba su ancho completo y empujaba los badges fuera del
                          contenedor — que con `overflow:hidden` los recortaba hasta hacerlos
                          desaparecer. Un nombre largo ahora corta con puntos suspensivos y
                          los badges quedan siempre visibles. */}
                      <span className="block text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {skill.name}
                      </span>
                      <span className="flex flex-wrap items-center gap-1 mt-0.5">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0
                          bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
                          v{skill.version}
                        </span>
                        {/* De qué repo salió. Es lo que distingue dos skills con el mismo
                            nombre traídas de repositorios distintos, así que va acá arriba y
                            no escondido en el detalle. */}
                        <span
                          title={t("skills.list.fromRegistry", {
                            registry: skill.registryName ?? t("skills.list.localOrigin"),
                          })}
                          className={`flex items-center gap-1 min-w-0 max-w-full text-[10px] px-1.5 py-0.5
                            rounded-full font-normal
                            ${skill.registryName
                              ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                              : "bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400"}`}
                        >
                          {skill.registryName
                            ? <CloudIcon className="w-2.5 h-2.5 shrink-0" />
                            : <FolderIcon className="w-2.5 h-2.5 shrink-0" />}
                          <span className="truncate">
                            {skill.registryName ?? t("skills.list.localOrigin")}
                          </span>
                        </span>
                        {/* El autor, al lado del repo: dos skills con el mismo nombre y el
                            mismo repositorio de origen solo se distinguen por acá. */}
                        {skill.author && (
                          <span
                            title={t("marketplace.author", { author: skill.author })}
                            className="min-w-0 max-w-full truncate text-[10px] px-1.5 py-0.5 rounded-full
                              font-normal bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          >
                            {skill.author}
                          </span>
                        )}
                      </span>
                      {skill.description && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">
                          {skill.description}
                        </span>
                      )}
                      {skill.categories.length > 0 && (
                        <span className="flex flex-wrap gap-1 mt-1.5">
                          {skill.categories.map((c) => (
                            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                              {c}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-1 px-4 pb-3">
                    <Button
                      variant="icon"
                      onClick={() => setExpandedId(expanded ? null : skill.id)}
                      title={t("skills.list.usedBy", { count: skill.usedBy.length })}
                      className="flex items-center gap-1 !text-xs"
                    >
                      {skill.usedBy.length}
                      <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </Button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button variant="icon" onClick={() => setAttachTarget(skill)} title={t("skills.attach.title", { name: skill.name })}>
                        <CopyIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="icon" onClick={() => navigate(`/skills/${skill.id}`)} title={t("skills.detail.title")}>
                        <EditIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="icon" onClick={() => setDeleteTarget(skill)} title={t("skills.delete.confirm")}
                        className="hover:text-red-500! dark:hover:text-red-400!">
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="px-4 pb-3 border-t border-gray-100 dark:border-white/5">
                      {skill.usedBy.length === 0 ? (
                        <p className="text-xs italic text-gray-400 dark:text-gray-500 pt-3">
                          {t("skills.list.notAttached")}
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-1 pt-3">
                          {skill.usedBy.map((u, i) => (
                            <li
                              key={i}
                              className="flex items-center justify-between gap-2 text-xs font-mono
                                text-gray-500 dark:text-gray-400 px-2 py-1 rounded-lg bg-gray-50 dark:bg-white/5"
                            >
                              <span className="truncate">
                                {u.workspaceName}
                                {u.scope === "tab"
                                  ? ` › ${u.tabTitle ?? u.tabId}`
                                  : ` (${t("skills.attach.scopeWorkspace")})`}
                              </span>
                              <Button
                                variant="icon"
                                onClick={() => handleDetach(skill, u.workspaceId, u.scope, u.tabId)}
                                title={t("skills.list.detach")}
                              >
                                <TrashIcon className="w-3.5 h-3.5" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {installOpen && <InstallSkillDialog onClose={() => setInstallOpen(false)} />}
      {deleteTarget && <DeleteSkillDialog skill={deleteTarget} onClose={() => setDeleteTarget(null)} />}
      {attachTarget && <AttachSkillDialog skill={attachTarget} onClose={() => setAttachTarget(null)} />}
    </main>
  );
}
