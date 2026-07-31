import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Select } from "neogestify-ui-components";
import { TrashIcon, EditIcon, ThemeToggle, FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";
import { CustomAgent, useSettingsStore } from "../store/settings";
import { useSkillsStore } from "../store/skills";
import { CustomAgentForm } from "../components/settings/CustomAgentForm";
import { CliInstallSection } from "../components/settings/CliInstallSection";

/** Chips de "qué integración tiene configurada esta TUI", para no tener que abrir el
 *  formulario solo para saber si reanuda sesiones o si le gestionamos skills. */
function AgentCapabilities({ agent }: { agent: CustomAgent }) {
  const { t } = useTranslation();
  const caps = [
    agent.resumeArgs && t("settings.tuis.cap.resume"),
    agent.skillsDir && t("settings.tuis.cap.skills"),
    agent.sessionsDir && t("settings.tuis.cap.sessions"),
    Object.keys(agent.env ?? {}).length > 0 && t("settings.tuis.cap.env"),
  ].filter(Boolean) as string[];

  if (caps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {caps.map((c) => (
        <span key={c} className="text-[10px] px-1.5 py-0.5 rounded
          bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
          {c}
        </span>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { customAgents, loadCustomAgents, saveCustomAgent, removeCustomAgent } = useSettingsStore();
  const { skillsDir, loadSkillsDir, setSkillsDir } = useSkillsStore();
  /** Id de la TUI que se está editando en línea; `null` = solo el formulario de alta. */
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  const handleChangeSkillsDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("settings.skillsDir") });
    if (typeof selected === "string" && selected) {
      await setSkillsDir(selected);
    }
  };

  const handleLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem("language", lang);
  };

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            {t("settings.title")}
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            {t("settings.subtitle")}
          </p>
        </div>

        <div className="space-y-6">

          {/* Apariencia */}
          <section className="bg-linear-to-br from-white to-gray-50
            dark:from-gray-800 dark:to-gray-900
            rounded-xl border border-gray-200 dark:border-gray-700
            shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              {t("settings.appearance")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              {t("settings.appearance.desc")}
            </p>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t("settings.theme")}
                </span>
                <ThemeToggle />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t("settings.language")}
                </span>
                <Select
                  value={i18n.language}
                  onChange={(e) => handleLanguage(e.target.value)}
                  variant="outline"
                  size="sm"
                  options={[
                    { value: "es", label: "Español" },
                    { value: "en", label: "English" },
                  ]}
                />
              </div>
            </div>
          </section>

          {/* Directorio de skills */}
          <section className="bg-linear-to-br from-white to-gray-50
            dark:from-gray-800 dark:to-gray-900
            rounded-xl border border-gray-200 dark:border-gray-700
            shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              {t("settings.skillsDir")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              {t("settings.skillsDir.desc")}
            </p>

            <div className="flex items-center gap-2">
              <FolderIcon className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" />
              <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate flex-1">
                {skillsDir || "…"}
              </span>
              <Button variant="outline" onClick={handleChangeSkillsDir} className="!text-sm shrink-0">
                {t("settings.skillsDir.change")}
              </Button>
            </div>
          </section>

          {/* TUIs personalizadas */}
          <section className="bg-linear-to-br from-white to-gray-50
            dark:from-gray-800 dark:to-gray-900
            rounded-xl border border-gray-200 dark:border-gray-700
            shadow-sm hover:shadow-md transition-shadow duration-300 p-6">

            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              {t("settings.tuis")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              {t("settings.tuis.desc")}
            </p>

            {/* List */}
            {customAgents.length === 0 ? (
              <p className="text-sm italic text-gray-400 dark:text-gray-500 mb-5">
                {t("settings.tuis.empty")}
              </p>
            ) : (
              <div className="flex flex-col gap-2 mb-5">
                {customAgents.map((agent) => (
                  editingId === agent.id ? (
                    <CustomAgentForm
                      key={agent.id}
                      initial={agent}
                      onSubmit={async (draft) => {
                        await saveCustomAgent(draft);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <div
                      key={agent.id}
                      className="flex items-center justify-between gap-3 px-4 py-3
                        rounded-lg border border-gray-200 dark:border-gray-700
                        bg-gray-50 dark:bg-gray-800/50
                        hover:border-gray-300 dark:hover:border-gray-600
                        transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                            {agent.label}
                          </span>
                          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">
                            {agent.command}
                          </span>
                          <AgentCapabilities agent={agent} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button variant="outline" onClick={() => setEditingId(agent.id)}>
                          <EditIcon className="w-4 h-4" />
                        </Button>
                        <Button variant="danger" onClick={() => removeCustomAgent(agent.id)}>
                          <TrashIcon className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}

            <CustomAgentForm onSubmit={saveCustomAgent} />
          </section>

          <CliInstallSection />

        </div>
      </div>
    </main>
  );
}
