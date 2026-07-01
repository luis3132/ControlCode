import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { AddIcon, BackIcon, EditIcon, TrashIcon, ChevronDownIcon, CopyIcon } from "neogestify-ui-components";
import { useSkillsStore, SkillSummary } from "../store/skills";
import { useTabsStore } from "../store/tabs";
import { InstallSkillDialog } from "../components/skills/InstallSkillDialog";
import { DeleteSkillDialog } from "../components/skills/DeleteSkillDialog";
import { AttachSkillDialog } from "../components/skills/AttachSkillDialog";

export function SkillsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, loadSkills, detachSkill, checkHealth, brokenSymlinks } = useSkillsStore();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null);
  const [attachTarget, setAttachTarget] = useState<SkillSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">

        <div className="flex items-center justify-between gap-3 mb-10">
          <div className="flex items-center gap-3">
            <Button variant="icon" onClick={() => navigate("/")} title={t("btn.back")}>
              <BackIcon className="w-4 h-4" />
            </Button>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {t("skills.manage.title")}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("skills.manage.subtitle")}
              </p>
            </div>
          </div>
          <Button variant="primary" onClick={() => setInstallOpen(true)} className="flex items-center gap-1.5 !text-sm w-fit">
            <AddIcon className="w-4 h-4" />
            {t("skills.install.btn")}
          </Button>
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400 mb-4">{error}</p>}

        {brokenSymlinks.length > 0 && (
          <div className="mb-6 p-4 rounded-lg border border-amber-300 dark:border-amber-700
            bg-amber-50 dark:bg-amber-500/10">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400 mb-2">
              {t("skills.health.title")}
            </p>
            <ul className="flex flex-col gap-1">
              {brokenSymlinks.map((issue, i) => {
                const skill = skills.find((s) => s.name === issue.skillName);
                const usage = skill?.usedBy.find((u) => u.tabId === issue.tabId);
                return (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs font-mono text-amber-800 dark:text-amber-300">
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

        {skills.length === 0 ? (
          <p className="text-sm italic text-gray-400 dark:text-gray-500">{t("skills.list.empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((skill) => {
              const expanded = expandedId === skill.id;
              return (
                <div
                  key={skill.id}
                  className="rounded-lg border border-gray-200 dark:border-gray-700
                    bg-white dark:bg-gray-800/50
                    hover:border-gray-300 dark:hover:border-gray-600
                    transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <button
                      onClick={() => navigate(`/skills/${skill.id}`)}
                      className="flex flex-col min-w-0 text-left flex-1"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                        {skill.name}
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400">
                          v{skill.version}
                        </span>
                      </span>
                      {skill.description && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
                          {skill.description}
                        </span>
                      )}
                      {skill.categories.length > 0 && (
                        <span className="flex flex-wrap gap-1 mt-1">
                          {skill.categories.map((c) => (
                            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                              {c}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="icon"
                        onClick={() => setExpandedId(expanded ? null : skill.id)}
                        title={t("skills.list.usedBy", { count: skill.usedBy.length })}
                        className="flex items-center gap-1 !text-xs"
                      >
                        {skill.usedBy.length}
                        <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
                      </Button>
                      <Button variant="icon" onClick={() => setAttachTarget(skill)} title={t("skills.attach.title", { name: skill.name })}>
                        <CopyIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="icon" onClick={() => navigate(`/skills/${skill.id}`)} title={t("skills.detail.title")}>
                        <EditIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="danger" onClick={() => setDeleteTarget(skill)} title={t("skills.delete.confirm")}>
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
                                text-gray-500 dark:text-gray-400 px-2 py-1 rounded bg-gray-50 dark:bg-white/5"
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
