import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Select } from "neogestify-ui-components";
import { TrashIcon, EditIcon, ThemeToggle, FolderIcon } from "neogestify-ui-components";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n/index";
import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";
import { useSkillsStore } from "@/features/skills/store";
import { CustomAgentForm } from "@/features/agents/CustomAgentForm";
import { CliInstallSection } from "@/features/settings/CliInstallSection";
import { OrchestratorSection } from "@/features/orchestrator/OrchestratorSection";
import { AccountsSection } from "@/features/accounts/AccountsSection";
import { PrelaunchSection } from "@/features/prelaunch/PrelaunchSection";
import { TerminalSection } from "@/features/terminal/TerminalSection";
import { SettingsNav, type SettingsSectionRef } from "@/features/settings/SettingsNav";

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

/** Marco común de una sección. El `id` es lo que ancla el índice lateral, y el `scroll-mt`
 *  deja aire arriba al saltar — si no, el título queda pegado al borde. */
function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-6">
      {children}
    </div>
  );
}

const CARD = `bg-linear-to-br from-white to-gray-50
  dark:from-gray-800 dark:to-gray-900
  rounded-xl border border-gray-200 dark:border-gray-700
  shadow-sm hover:shadow-md transition-shadow duration-300 p-6`;

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

  useEffect(() => {
    loadSkillsDir();
    loadCustomAgents().catch(console.error);
  }, [loadSkillsDir, loadCustomAgents]);

  // Mismo orden en el que se renderizan; el índice no lo deduce del DOM para que agregar
  // una sección sea una línea acá y no una convención implícita.
  const sections: SettingsSectionRef[] = useMemo(
    () => [
      { id: "appearance", label: t("settings.appearance") },
      { id: "terminal", label: t("settings.terminal") },
      { id: "skills-dir", label: t("settings.skillsDir") },
      { id: "tuis", label: t("settings.tuis") },
      { id: "accounts", label: t("settings.accounts") },
      { id: "prelaunch", label: t("settings.prelaunch") },
      { id: "cli", label: t("settings.cli") },
      { id: "orchestrator", label: t("settings.orchestrator") },
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
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            {t("settings.title")}
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            {t("settings.subtitle")}
          </p>
        </div>

        <div className="flex gap-8 justify-center">
          {/* El índice va a la IZQUIERDA, como la navegación de cualquier página de ajustes:
              se lee antes que el contenido y no compite con la barra de scroll de la
              derecha. La columna de contenido conserva su ancho de siempre — el índice se
              suma al costado en pantallas anchas en vez de estirar las tarjetas. */}
          <SettingsNav sections={sections} title={t("settings.nav")} />

          <div className="flex-1 max-w-2xl min-w-0 space-y-6">

            {/* Apariencia */}
            <Section id="appearance">
              <section className={CARD}>
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
            </Section>

            <Section id="terminal">
              <TerminalSection />
            </Section>

            {/* Directorio de skills */}
            <Section id="skills-dir">
              <section className={CARD}>
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
                  <Button variant="outline" onClick={handleChangeSkillsDir} className="text-sm! shrink-0">
                    {t("settings.skillsDir.change")}
                  </Button>
                </div>
              </section>
            </Section>

            {/* TUIs personalizadas */}
            <Section id="tuis">
              <section className={CARD}>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
                  {t("settings.tuis")}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                  {t("settings.tuis.desc")}
                </p>

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
            </Section>

            <Section id="accounts">
              <AccountsSection />
            </Section>

            <Section id="prelaunch">
              <PrelaunchSection />
            </Section>

            <Section id="cli">
              <CliInstallSection />
            </Section>

            <Section id="orchestrator">
              <OrchestratorSection />
            </Section>

          </div>
        </div>
      </div>
    </main>
  );
}
