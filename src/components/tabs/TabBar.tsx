import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AddIcon } from "neogestify-ui-components";
import { useTabsStore } from "../../store/tabs";
import { TabItem } from "./TabItem";
import { NewTabWizard } from "../wizard/NewTabWizard";

export function TabBar() {
  const { tabs, activeTabId, activateTab, closeTab, renameTab, reorderTabs, addTab } =
    useTabsStore();
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDrop = (toIndex: number) => {
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  return (
    <>
      <div className="flex items-stretch h-9 shrink-0 overflow-x-auto
        bg-gray-100 dark:bg-[#161b22]
        border-b border-gray-200 dark:border-white/10">
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isDragOver={dragOverIndex === index && draggedIndex !== index}
            onActivate={() => {
              activateTab(tab.id);
              navigate("/workspace");
            }}
            onClose={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
            onRenameCommit={(title) => renameTab(tab.id, title)}
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(e) => { e.preventDefault(); setDragOverIndex(index); }}
            onDrop={() => handleDrop(index)}
          />
        ))}

        <button
          onClick={() => setWizardOpen(true)}
          title="Nueva terminal"
          className="flex items-center justify-center w-9 h-9 shrink-0
            text-gray-400 dark:text-white/40
            hover:text-gray-700 dark:hover:text-white/80
            hover:bg-gray-200 dark:hover:bg-white/5
            transition-colors"
        >
          <AddIcon />
        </button>
      </div>

      <NewTabWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConfirm={({ cwd, agent }) => {
          addTab({ cwd, agent });
          navigate("/workspace");
        }}
      />
    </>
  );
}
