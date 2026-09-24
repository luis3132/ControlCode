import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Button, Input } from "neogestify-ui-components";
import { CloudIcon, FolderIcon, HomeIcon, ArrowRightIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import { useWorkspacesStore } from "@/features/workspaces/store";
import type { WorkspaceSummary } from "@/features/workspaces/types";
import { WorkspaceList } from "@/features/workspaces/WorkspaceList";
import { OpenWorkspaceDialog } from "@/features/workspaces/OpenWorkspaceDialog";
import { SkillPickerStep } from "@/features/tabs/wizard/SkillPickerStep";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { AccountPickerStep } from "@/features/tabs/wizard/AccountPickerStep";
import { AgentPickerStep } from "@/features/tabs/wizard/AgentPickerStep";
import { AdvancedOptions } from "@/features/tabs/wizard/AdvancedOptions";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { homeDir } from "@/shared/ipc/window";
import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { CloneRepoDialog } from "@/features/forge/CloneRepoDialog";

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addTab = useTabsStore((s) => s.addTab);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const focusIfOpen = useWorkspacesStore((s) => s.focusIfOpen);
  const [selectedCwd, setSelectedCwd] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  /** `undefined` = la cuenta del sistema (ver AccountPickerStep). */
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>();
  const [prelaunch, setPrelaunch] = useState<PrelaunchStep[]>([]);
  const [pathError, setPathError] = useState("");
  const [cloning, setCloning] = useState(false);
  const [openTarget, setOpenTarget] = useState<WorkspaceSummary | null>(null);

  useEffect(() => {
    loadWorkspaces();
    // El número de ventanas/tabs de un workspace puede cambiar desde OTRA ventana
    // (cerrar una ventana, agregar una tab, etc.) — sin esto, el conteo se quedaba
    // congelado en lo que había al montar esta página.
    const unlisten = listen("cc-workspace-changed", () => loadWorkspaces());
    return () => { unlisten.then((fn) => fn()); };
  }, [loadWorkspaces]);

  const allAgents = useAvailableAgents();

  const canOpen = selectedCwd.trim() !== "" && selectedAgent !== null;

  // Si el workspace elegido ya tiene ventanas vivas, se enfocan en vez de abrir otro
  // juego duplicado de ventanas para el mismo workspace.
  const handleSelectWorkspace = async (ws: WorkspaceSummary) => {
    const focused = await focusIfOpen(ws.id);
    if (!focused) setOpenTarget(ws);
  };

  const handleHome = async () => {
    const home = await homeDir();
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
    const tabId = addTab({
      cwd: selectedCwd.trim(),
      agent: selectedAgent,
      accountId: selectedAccountId,
      prelaunch,
    });
    navigate("/workspace");

    // Mismo gate que el wizard del "+" (ver TabBar.tsx): los symlinks de las skills
    // elegidas (más las que ya estaban attacheadas a nivel workspace) tienen que
    // existir en el cwd ANTES de que el agente arranque — Terminal.tsx espera esta
    // promesa antes de invocar pty_create.
    registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, selectedSkillIds));
  };

  return (
    <div className="cc-scroll flex flex-col items-center h-full px-6 py-12
      bg-gray-50 dark:bg-gray-950">

      <div className="w-full max-w-xl flex flex-col gap-8">

        {/* Header */}
        <div className="flex flex-col gap-1.5 w-full items-center text-center">
          <h1 className="text-3xl font-bold bg-clip-text text-transparent
            bg-linear-to-r from-blue-600 to-violet-600
            dark:from-blue-400 dark:to-violet-400">
            {t("app.title")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("app.subtitle")}
          </p>
        </div>

        {/* Open project card */}
        <div className="w-full rounded-xl border border-gray-200 dark:border-gray-700
          bg-white dark:bg-gray-800/50 p-6 flex flex-col gap-7 shadow-sm">

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
              {/* Un repo que todavía no está en esta máquina: se clona con la cuenta de git
                  y la carpeta nueva queda elegida. */}
              <Button variant="outline" onClick={() => setCloning(true)}
                className="flex items-center gap-1.5 text-xs! h-8! px-3!">
                <CloudIcon className="w-3.5 h-3.5" />
                {t("forge.clone.button")}
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

            <AgentPickerStep
              agents={allAgents}
              selected={selectedAgent?.id ?? null}
              onSelect={(agent) => {
                setSelectedAgent(agent);
                setSelectedSkillIds([]);
                // Las cuentas son por TUI: la elegida para otra no aplica acá.
                setSelectedAccountId(undefined);
              }}
            />
          </div>

          {/* Cuenta — solo aparece si esta TUI tiene más de una (ver AccountPickerStep) */}
          {selectedAgent && (
            <AccountPickerStep
              agentId={selectedAgent.id}
              value={selectedAccountId}
              onChange={setSelectedAccountId}
            />
          )}

          {/* Comandos previos al lanzamiento — plegado, ver AdvancedOptions */}
          {selectedAgent && (
            <AdvancedOptions
              agentCommand={selectedAgent.command}
              prelaunch={prelaunch}
              onPrelaunchChange={setPrelaunch}
            />
          )}

          {/* Skills — la terminal pelada no es un agente: no tiene */}
          {selectedAgent && selectedAgent.id !== SHELL_AGENT_ID && (
            <div className="flex flex-col gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-widest
                text-gray-400 dark:text-gray-500">
                {t("home.step3")}
              </span>
              <SkillPickerStep
                agentId={selectedAgent.id}
                selected={selectedSkillIds}
                onChange={setSelectedSkillIds}
              />
            </div>
          )}

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

        {workspaces.length > 0 && (
          <WorkspaceList workspaces={workspaces} onSelect={handleSelectWorkspace} />
        )}

      </div>

      {openTarget && (
        <OpenWorkspaceDialog workspace={openTarget} onClose={() => setOpenTarget(null)} />
      )}

      {cloning && (
        <CloneRepoDialog
          onClose={() => setCloning(false)}
          onCloned={(path) => {
            setCloning(false);
            setSelectedCwd(path);
            setPathError("");
          }}
        />
      )}
    </div>
  );
}
