import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { TrashIcon, AddIcon, ThemeToggle, FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";
import { useSettingsStore } from "../store/settings";
import { useSkillsStore } from "../store/skills";

export function SettingsPage() {
  const { t } = useTranslation();
  const { customAgents, addCustomAgent, removeCustomAgent } = useSettingsStore();
  const { skillsDir, loadSkillsDir, setSkillsDir } = useSkillsStore();
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadSkillsDir();
  }, [loadSkillsDir]);

  const handleChangeSkillsDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("settings.skillsDir") });
    if (typeof selected === "string" && selected) {
      await setSkillsDir(selected);
    }
  };

  const handleAdd = () => {
    if (!label.trim() || !command.trim()) {
      setError(t("settings.tuis.error"));
      return;
    }
    addCustomAgent({ label: label.trim(), command: command.trim() });
    setLabel("");
    setCommand("");
    setError("");
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
                <select
                  value={i18n.language}
                  onChange={(e) => handleLanguage(e.target.value)}
                  className="text-sm rounded-lg border px-3 py-1.5
                    bg-white dark:bg-gray-700
                    border-gray-200 dark:border-gray-600
                    text-gray-800 dark:text-gray-100
                    focus:outline-none focus:ring-2 focus:ring-blue-500
                    transition-colors cursor-pointer"
                >
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </select>
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
                      </div>
                    </div>
                    <Button variant="danger" onClick={() => removeCustomAgent(agent.id)}>
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add form */}
            <div className="flex flex-col gap-3 p-4 rounded-lg border border-dashed
              border-gray-300 dark:border-gray-600
              bg-gray-50/50 dark:bg-gray-900/30">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t("settings.tuis.addSection")}
              </p>
              <div className="flex gap-2">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder={t("settings.tuis.namePlaceholder")}
                  variant="outline"
                />
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder={t("settings.tuis.commandPlaceholder")}
                  variant="outline"
                />
              </div>
              {error && (
                <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
              )}
              <Button variant="primary" onClick={handleAdd}
                className="flex items-center gap-1.5 !text-sm w-fit">
                <AddIcon className="w-4 h-4" />
                {t("btn.add")}
              </Button>
            </div>
          </section>

        </div>
      </div>
    </main>
  );
}
