import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";
import { FolderIcon, HomeIcon, ArrowRightIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import { useTabsStore, AgentInfo } from "../store/tabs";
import { useSettingsStore } from "../store/settings";

const AGENT_ICONS: Record<string, string> = {
  "claude-code": "🤖",
  "gemini-cli":  "✨",
  "codex":       "⚡",
  "bash":        "🖥",
};

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
      id: ca.id,
      label: ca.label,
      command: ca.command,
      available: true,
      isCustom: true,
    })),
  ];

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
    <div className="flex flex-col items-center justify-center h-full px-6 gap-8
      bg-gray-50 dark:bg-[#0d1117]">

      {/* Logo */}
      <div className="flex flex-col items-center gap-1 text-center select-none">
        <h1 className="text-4xl font-bold bg-linear-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent">
          {t("app.title")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-white/40">
          {t("app.subtitle")}
        </p>
      </div>

      {/* Card */}
      <div className="w-full max-w-lg rounded-2xl border shadow-lg overflow-hidden
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10">

        {/* Sección: Carpeta */}
        <div className="p-5 flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider
            text-gray-400 dark:text-white/40">
            {t("home.step1")}
          </p>

          <div className="flex gap-2">
            <Button variant="outline" leftIcon={<HomeIcon />} onClick={handleHome}>
              {t("btn.home")}
            </Button>
            <Button variant="outline" leftIcon={<FolderIcon />} onClick={handleExplorer}>
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

        <div className="h-px bg-gray-100 dark:bg-white/10" />

        {/* Sección: Agente */}
        <div className="p-5 flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider
            text-gray-400 dark:text-white/40">
            {t("home.step2")}
          </p>

          {allAgents.filter(a => a.available).length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-white/30 italic">
              {t("home.detecting")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {allAgents.filter(a => a.available).map((agent) => {
                const isSelected = agent.id === selectedAgent?.id;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent)}
                    className={`
                      flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all
                      ${isSelected
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-500/10 ring-1 ring-blue-500"
                        : "border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/25 bg-gray-50 dark:bg-white/[0.02] hover:bg-gray-100 dark:hover:bg-white/5"}
                    `}
                  >
                    <span className="text-xl shrink-0">{AGENT_ICONS[agent.id] ?? "🔧"}</span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className={`text-sm font-medium truncate
                        ${isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-800 dark:text-white/90"}`}>
                        {agent.label}
                      </span>
                      <span className="text-xs font-mono text-gray-400 dark:text-white/40 truncate">
                        {agent.command}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="h-px bg-gray-100 dark:bg-white/10" />

        {/* Botón abrir */}
        <div className="p-5">
          <Button
            variant="primary"
            fullWidth
            rightIcon={<ArrowRightIcon />}
            onClick={handleOpen}
            disabled={!canOpen}
          >
            {t("home.openProject")}
          </Button>
        </div>
      </div>
    </div>
  );
}
