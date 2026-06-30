import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { FolderIcon, HomeIcon, ArrowRightIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import { useTabsStore, AgentInfo } from "../store/tabs";
import { useSettingsStore } from "../store/settings";

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { addTab, detectedAgents } = useTabsStore();
  const { customAgents } = useSettingsStore();
  const [selectedCwd, setSelectedCwd] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [pathError, setPathError] = useState("");

  const allAgents: AgentInfo[] = [
    ...detectedAgents,
    ...customAgents.map((ca) => ({
      id: ca.id, label: ca.label, command: ca.command,
      available: true, isCustom: true,
    })),
  ].filter((a) => a.available);

  const canOpen = selectedCwd.trim() !== "" && selectedAgent !== null;

  const handleHome = async () => {
    const home = await invoke<string>("get_home_dir");
    setSelectedCwd(home);
    setPathError("");
  };

  const handleExplorer = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("home.dialogTitle") });
    if (typeof selected === "string" && selected) {
      setSelectedCwd(selected);
      setPathError("");
    }
  };

  const handleOpen = () => {
    if (!selectedCwd.trim()) { setPathError(t("home.error.noFolder")); return; }
    if (!selectedAgent) return;
    addTab({ cwd: selectedCwd.trim(), agent: selectedAgent });
    navigate("/workspace");
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-8
      bg-gray-50 dark:bg-gray-950">

      <div className="w-full max-w-md flex flex-col gap-10">

        {/* Header */}
        <div className="flex flex-col gap-1 w-full items-center">
          <h1 className="text-3xl font-bold bg-clip-text text-transparent
            bg-linear-to-r from-blue-600 to-violet-600
            dark:from-blue-400 dark:to-violet-400">
            {t("app.title")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("app.subtitle")}
          </p>
        </div>

        {/* Folder */}
        <div className="flex flex-col gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest
            text-gray-400 dark:text-gray-500">
            {t("home.step1")}
          </span>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleHome}
              className="flex items-center gap-1.5 text-xs! h-8! px-3!">
              <HomeIcon className="w-3.5 h-3.5" />
              {t("btn.home")}
            </Button>
            <Button variant="outline" onClick={handleExplorer}
              className="flex items-center gap-1.5 text-xs! h-8! px-3!">
              <FolderIcon className="w-3.5 h-3.5" />
              {t("btn.browse")}
            </Button>
          </div>

          <Input
            value={selectedCwd}
            onChange={(e) => { setSelectedCwd(e.target.value); setPathError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleOpen()}
            placeholder={t("home.pathPlaceholder")}
            variant="outline"
            error={pathError}
          />
        </div>

        {/* Agent picker */}
        <div className="flex flex-col gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest
            text-gray-400 dark:text-gray-500">
            {t("home.step2")}
          </span>

          {allAgents.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic">
              {t("home.detecting")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {allAgents.map((agent) => {
                const isSelected = agent.id === selectedAgent?.id;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent)}
                    className={`
                      group flex flex-col gap-1 px-4 py-3 rounded-sm border text-left
                      transition-all duration-200
                      ${isSelected
                        ? "border-blue-500 bg-linear-to-br from-blue-50 to-violet-50 dark:from-blue-500/10 dark:to-violet-500/10 shadow-sm"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm"}
                    `}
                  >
                    <span className={`text-sm font-semibold transition-colors
                      ${isSelected
                        ? "text-blue-700 dark:text-blue-300"
                        : "text-gray-800 dark:text-gray-100 group-hover:text-gray-900 dark:group-hover:text-white"}`}>
                      {agent.label}
                    </span>
                    <span className={`text-xs font-mono transition-colors
                      ${isSelected
                        ? "text-blue-500/70 dark:text-blue-400/70"
                        : "text-gray-400 dark:text-gray-500"}`}>
                      {agent.command}
                    </span>
                    {agent.isCustom && (
                      <span className="text-[10px] font-medium text-violet-500 dark:text-violet-400">
                        custom
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Submit */}
        <Button
          variant="primary"
          fullWidth
          onClick={handleOpen}
          disabled={!canOpen}
          className="flex items-center justify-center gap-2 h-10! text-sm! font-semibold!"
        >
          {t("home.openProject")}
          <ArrowRightIcon className="w-4 h-4" />
        </Button>

      </div>
    </div>
  );
}
