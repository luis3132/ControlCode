import { useTranslation } from "react-i18next";
import { Terminal } from "../Terminal";
import { useTabsStore } from "../../store/tabs";

export function TerminalPanel() {
  const { t } = useTranslation();
  const { tabs, activeTabId, setPtyId } = useTabsStore();

  return (
    // h-full en lugar de flex-1: el padre es position:absolute;inset:0 (no flex),
    // así que h-full es la única forma de darle altura real al panel.
    <div className="relative h-full w-full overflow-hidden bg-gray-100 dark:bg-[#0d1117]">
      {tabs.map((tab) => (
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
            command={tab.command}
            cwd={tab.cwd}
            onReady={(ptyId) => setPtyId(tab.id, ptyId)}
          />
        </div>
      ))}

      {tabs.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-white/20">
          <span className="text-5xl select-none">⌥</span>
          <p className="text-sm">{t("terminal.empty")}</p>
        </div>
      )}
    </div>
  );
}
