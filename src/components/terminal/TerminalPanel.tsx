import { useTranslation } from "react-i18next";
import { Terminal } from "../Terminal";
import { useTabsStore } from "../../store/tabs";
import { buildResumeCommand, RESUMABLE_AGENT_IDS } from "../../lib/agentResume";

export function TerminalPanel() {
  const { t } = useTranslation();
  const { tabs, activeTabId, setPtyId, setSessionId } = useTabsStore();

  return (
    // h-full en lugar de flex-1: el padre es position:absolute;inset:0 (no flex),
    // así que h-full es la única forma de darle altura real al panel.
    <div className="relative h-full w-full overflow-hidden bg-gray-100 dark:bg-[#0d1117]">
      {tabs.map((tab) => {
        // El resume del agente ya reconstruye su propia conversación; reproducir
        // también el scrollback crudo aquí duplicaría/ensuciaría la salida.
        const isResuming = !!tab.sessionId && RESUMABLE_AGENT_IDS.includes(tab.agentId);
        return (
          <div
            key={tab.id}
            style={{
              position: "absolute",
              inset: 0,
              visibility: tab.id === activeTabId ? "visible" : "hidden",
              pointerEvents: tab.id === activeTabId ? "auto" : "none",
              zIndex: tab.id === activeTabId ? 1 : 0,
            }}
          >
            <Terminal
              command={buildResumeCommand(tab.agentId, tab.command, tab.sessionId)}
              cwd={tab.cwd}
              agentId={tab.agentId}
              attachPtyId={tab.ptyId ?? undefined}
              initialScrollback={isResuming ? undefined : tab.scrollback}
              onReady={(ptyId) => setPtyId(tab.id, ptyId)}
              onSessionDiscovered={(sessionId) => setSessionId(tab.id, sessionId)}
            />
          </div>
        );
      })}

      {tabs.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-white/20">
          <span className="text-5xl select-none">⌥</span>
          <p className="text-sm">{t("terminal.empty")}</p>
        </div>
      )}
    </div>
  );
}
