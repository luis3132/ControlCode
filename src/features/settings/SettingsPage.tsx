import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button, EditIcon, FolderIcon, Select, ThemeToggle, Tooltip, TrashIcon,
} from "neogestify-ui-components";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n/index";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { useSkillsStore } from "@/features/skills/store";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import { DetectedAgents } from "@/features/agents/DetectedAgents";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { GraphifySection } from "@/features/graphify/GraphifySection";
import { SkillsShSection } from "@/features/marketplace/SkillsShSection";
import { OrchestratorSection } from "@/features/orchestrator/OrchestratorSection";
import { RoutingSection } from "@/features/runs/RoutingSection";
import { PrelaunchSection } from "@/features/prelaunch/PrelaunchSection";
import { TerminalSection } from "@/features/terminal/TerminalSection";
import { ShortcutsSection } from "@/features/settings/ShortcutsSection";
import { SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { RenderingSetting } from "@/features/settings/RenderingSetting";

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
    <div className="flex flex-wrap gap-1 mt-0.5">
      {caps.map((c) => (
        <span key={c} className="text-[9.5px] px-1.5 rounded
          bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
          {c}
        </span>
      ))}
    </div>
  );
}

type SectionId =
  | "appearance" | "shortcuts" | "terminal" | "skillsDir" | "skillssh"
  | "tuis" | "prelaunch" | "cli" | "graphify" | "orchestrator" | "routing";

/**
 * El contenido de Configuración.
 *
 * Muestra UNA sección por vez en vez de apilarlas todas en un scroll con índice al
 * costado. En una ventana de alto fijo, el scroll largo obligaba a recorrer ajustes que no
 * se estaban buscando para llegar al que sí — y el índice existía justamente para
 * compensar eso. Eligiendo, la navegación deja de ser un parche sobre el scroll.
 *
 * Las cuentas ya no están acá: son algo que se administra y crece, no un ajuste, así que
 * tienen su propia pantalla (`AccountsModal`) y su propio botón en el riel.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const customAgents = useAgentsStore((s) => s.customAgents);
  const loadCustomAgents = useAgentsStore((s) => s.loadCustomAgents);
  const saveCustomAgent = useAgentsStore((s) => s.saveCustomAgent);
  const removeCustomAgent = useAgentsStore((s) => s.removeCustomAgent);
  const skillsDir = useSkillsStore((s) => s.skillsDir);
  const loadSkillsDir = useSkillsStore((s) => s.loadSkillsDir);
  const setSkillsDir = useSkillsStore((s) => s.setSkillsDir);
  /** Id de la TUI que se está editando en línea; `null` = solo el formulario de alta. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("appearance");

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  // El orden de la navegación. Agregar una sección es una línea acá más su caso abajo.
  const sections: { id: SectionId; label: string }[] = useMemo(
    () => [
      { id: "appearance", label: t("settings.appearance") },
      { id: "shortcuts", label: t("settings.shortcuts") },
      { id: "terminal", label: t("settings.terminal") },
      { id: "skillsDir", label: t("settings.skillsDir") },
      { id: "skillssh", label: t("settings.skillssh") },
      { id: "tuis", label: t("settings.tuis") },
      { id: "prelaunch", label: t("settings.prelaunch") },
      { id: "cli", label: t("settings.cli") },
      { id: "graphify", label: t("settings.graphify") },
      { id: "orchestrator", label: t("settings.orchestrator") },
      { id: "routing", label: t("settings.routing") },
    ],
    [t]
  );

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
    <>
      <nav className="flex flex-col w-48 shrink-0 min-h-0
        border-r border-gray-200 dark:border-white/8
        bg-gray-100/50 dark:bg-black/20">
        <div className="flex-1 min-h-0 cc-scroll p-1.5">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`cc-t flex items-center w-full h-8 px-2.5 rounded-lg text-left
                text-[11.5px]
                ${s.id === section
                  ? "bg-blue-500/12 dark:bg-blue-400/13 text-gray-900 dark:text-white font-semibold"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-white/6"}`}
            >
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="flex-1 min-w-0 min-h-0 cc-scroll px-5 py-4">
        {section === "appearance" && (
          <SettingsSection title={t("settings.appearance")} description={t("settings.appearance.desc")}>
            <div className="flex flex-col gap-1.5">
              <SettingsRow label={t("settings.theme")}>
                <ThemeToggle />
              </SettingsRow>
              <SettingsRow label={t("settings.language")}>
                <Select
                  value={i18n.language}
                  onChange={(e) => handleLanguage(e.target.value)}
                  variant="minimal"
                  size="sm"
                  options={[
                    { value: "es", label: "Español" },
                    { value: "en", label: "English" },
                  ]}
                />
              </SettingsRow>
              <RenderingSetting />
            </div>
          </SettingsSection>
        )}

        {section === "shortcuts" && <ShortcutsSection />}
        {section === "terminal" && <TerminalSection />}

        {section === "skillsDir" && (
          <SettingsSection
            title={t("settings.skillsDir")}
            description={t("settings.skillsDir.desc")}
            action={
              <Button variant="outline" size="sm" onClick={handleChangeSkillsDir}>
                {t("settings.skillsDir.change")}
              </Button>
            }
          >
            <div className="flex items-center gap-2 h-9 px-3 rounded-lg
              bg-gray-100/70 dark:bg-white/4">
              <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
              <span className="flex-1 min-w-0 truncate font-mono text-[11px]
                text-gray-600 dark:text-gray-300">
                {skillsDir || "…"}
              </span>
            </div>
          </SettingsSection>
        )}

        {section === "tuis" && (
          <SettingsSection title={t("settings.tuis")} description={t("settings.tuis.desc")}>
            <DetectedAgents />

            <span className="mt-2 text-[11px] font-semibold uppercase tracking-wide
              text-gray-400 dark:text-white/30">
              {t("settings.tuis.custom")}
            </span>
            {customAgents.length === 0 ? (
              <p className="text-[11.5px] text-gray-400 dark:text-white/30">
                {t("settings.tuis.empty")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
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
                      className="cc-t flex items-center gap-3 px-3 py-2 rounded-lg
                        bg-gray-100/70 dark:bg-white/4
                        hover:bg-gray-100 dark:hover:bg-white/6"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <div className="flex flex-col gap-px min-w-0 flex-1">
                        <span className="truncate text-[12.5px] font-semibold
                          text-gray-800 dark:text-gray-100">
                          {agent.label}
                        </span>
                        <span className="truncate font-mono text-[10.5px]
                          text-gray-400 dark:text-white/35">
                          {agent.command}
                        </span>
                        <AgentCapabilities agent={agent} />
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Tooltip content={t("btn.edit")} placement="left">
                          <button
                            onClick={() => setEditingId(agent.id)}
                            aria-label={t("btn.edit")}
                            className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                              text-gray-400 dark:text-white/35
                              hover:text-gray-700 dark:hover:text-white
                              hover:bg-gray-200 dark:hover:bg-white/10"
                          >
                            <EditIcon className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip content={t("btn.delete")} placement="left">
                          <button
                            onClick={() => removeCustomAgent(agent.id)}
                            aria-label={t("btn.delete")}
                            className="cc-t flex items-center justify-center w-7 h-7 rounded-md
                              text-gray-400 dark:text-white/35
                              hover:text-red-500 dark:hover:text-red-400
                              hover:bg-gray-200 dark:hover:bg-white/10"
                          >
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}

            <CustomAgentForm onSubmit={saveCustomAgent} />
          </SettingsSection>
        )}

        {section === "skillssh" && <SkillsShSection />}
        {section === "prelaunch" && <PrelaunchSection />}
        {section === "cli" && <CliInstallSection />}
        {section === "graphify" && <GraphifySection />}
        {section === "orchestrator" && <OrchestratorSection />}
        {section === "routing" && <RoutingSection />}
      </div>
    </>
  );
}
