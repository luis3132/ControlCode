import { useState } from "react";
import { Button, Input } from "neogestify-ui-components";
import { TrashIcon, AddIcon, ThemeToggle } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/index";
import { useSettingsStore } from "../store/settings";

export function SettingsPage() {
  const { t } = useTranslation();
  const { customAgents, addCustomAgent, removeCustomAgent } = useSettingsStore();
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

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
    <div className="flex flex-col min-h-full p-8 max-w-2xl mx-auto gap-8
      bg-gray-50 dark:bg-[#0d1117]">

      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("settings.title")}
        </h2>
        <p className="text-sm text-gray-500 dark:text-white/40 mt-1">
          {t("settings.subtitle")}
        </p>
      </div>

      {/* Apariencia */}
      <section className="flex flex-col gap-4 p-5 rounded-2xl border
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-white/70 uppercase tracking-wider">
            {t("settings.appearance")}
          </h3>
          <p className="text-xs text-gray-400 dark:text-white/40 mt-1">
            {t("settings.appearance.desc")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600 dark:text-white/60">{t("settings.theme")}</span>
          <ThemeToggle />
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600 dark:text-white/60">{t("settings.language")}</span>
          <select
            value={i18n.language}
            onChange={(e) => handleLanguage(e.target.value)}
            className="text-sm rounded-lg border px-3 py-1.5
              bg-gray-50 dark:bg-white/5
              border-gray-200 dark:border-white/20
              text-gray-800 dark:text-white/90
              focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>
      </section>

      {/* TUIs personalizadas */}
      <section className="flex flex-col gap-4 p-5 rounded-2xl border
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-white/70 uppercase tracking-wider">
            {t("settings.tuis")}
          </h3>
          <p className="text-xs text-gray-400 dark:text-white/40 mt-1">
            {t("settings.tuis.desc")}
          </p>
        </div>

        {customAgents.length === 0 ? (
          <p className="text-xs italic text-gray-400 dark:text-white/30 py-1">
            {t("settings.tuis.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {customAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border
                  bg-gray-50 dark:bg-white/5
                  border-gray-200 dark:border-white/10"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-gray-800 dark:text-white/90">
                    {agent.label}
                  </span>
                  <span className="text-xs font-mono text-gray-400 dark:text-white/40">
                    {agent.command}
                  </span>
                </div>
                <Button variant="danger" onClick={() => removeCustomAgent(agent.id)}>
                  <TrashIcon />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Formulario */}
        <div className="flex flex-col gap-3 p-4 rounded-xl border border-dashed
          border-gray-300 dark:border-white/20
          bg-gray-50 dark:bg-white/[0.02]">
          <p className="text-xs font-medium text-gray-500 dark:text-white/50">
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
          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          <Button variant="primary" leftIcon={<AddIcon />} onClick={handleAdd}>
            {t("btn.add")}
          </Button>
        </div>
      </section>
    </div>
  );
}
