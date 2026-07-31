import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Terminal } from "../Terminal";
import { useTabsStore } from "../../store/tabs";
import { buildResumeCommand, isResumable } from "../../lib/agentResume";

export function TerminalPanel() {
  const { t } = useTranslation();
  const { tabs, activeTabId, setPtyId, setSessionId } = useTabsStore();
  // El panel sigue montado (para no matar los PTYs) pero oculto fuera de /workspace, así
  // que "ser la tab activa" no alcanza para enfocar: en Skills o Settings el foco tiene que
  // quedarse en esa página, no robárselo una terminal invisible.
  const onWorkspace = useLocation().pathname.startsWith("/workspace");

  return (
    // h-full en lugar de flex-1: el padre es position:absolute;inset:0 (no flex),
    // así que h-full es la única forma de darle altura real al panel.
    <div className="relative h-full w-full overflow-hidden bg-gray-100 dark:bg-[#0d1117]">
      {tabs.map((tab) => {
        // El resume del agente ya reconstruye su propia conversación; reproducir
        // también el scrollback crudo aquí duplicaría/ensuciaría la salida.
        const isResuming = !!tab.sessionId && isResumable(tab.agentId);
        return (
          <div
            key={tab.id}
            style={{
              position: "absolute",
              inset: 0,
              // Sin "visible" explícito: así hereda el visibility del contenedor de
              // AppShell (que lo oculta fuera de /workspace) en vez de sobreescribirlo.
              visibility: tab.id === activeTabId ? undefined : "hidden",
              pointerEvents: tab.id === activeTabId ? "auto" : "none",
              zIndex: tab.id === activeTabId ? 1 : 0,
            }}
          >
            <Terminal
              tabId={tab.id}
              command={buildResumeCommand(tab.agentId, tab.command, tab.sessionId)}
              cwd={tab.cwd}
              agentId={tab.agentId}
              attachPtyId={tab.ptyId ?? undefined}
              initialScrollback={isResuming ? undefined : tab.scrollback}
              isActive={tab.id === activeTabId && onWorkspace}
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
