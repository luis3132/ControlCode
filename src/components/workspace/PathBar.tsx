import { FolderIcon } from "neogestify-ui-components";
import { useTabsStore } from "../../store/tabs";

export function PathBar() {
  const { tabs, activeTabId } = useTabsStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex items-center gap-2 px-3 h-7 shrink-0
      bg-gray-50 dark:bg-[#0d1117]
      border-b border-gray-200 dark:border-white/10">
      <span className="w-3.5 h-3.5 flex items-center shrink-0
        text-gray-400 dark:text-white/30">
        <FolderIcon />
      </span>
      <span className="text-xs font-mono truncate
        text-gray-500 dark:text-white/40">
        {activeTab?.cwd ?? ""}
      </span>
    </div>
  );
}
