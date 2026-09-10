import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AddIcon } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { TabItem } from "@/features/tabs/TabItem";
import { TabContextMenu } from "@/features/tabs/TabContextMenu";
import { NewTabWizard } from "@/features/tabs/wizard/NewTabWizard";
import { refreshSessionTitle } from "@/features/sessions/sessionTitle";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

/**
 * Las tabs de agente, dentro de la barra de título.
 *
 * Arrancan justo donde termina el lateral izquierdo y no llevan nada a la derecha: el
 * resto de la franja es zona de arrastre de la ventana. Antes había 44px de barra con
 * navegación y controles MÁS 36px de tira de tabs, y la de arriba era casi todo color.
 *
 * Arrastrar una tab la reordena, y nada más. Sacarla de la barra para abrir otra ventana
 * ya no existe: un workspace es una carpeta con agentes adentro y se cambia desde el
 * panel izquierdo, sin abrir ventanas.
 */
export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const renameTab = useTabsStore((s) => s.renameTab);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);
  const addTab = useTabsStore((s) => s.addTab);
  const updateTab = useTabsStore((s) => s.updateTab);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const clearDrag = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (toIndex: number) => {
    if (draggedIndex !== null && draggedIndex !== toIndex) reorderTabs(draggedIndex, toIndex);
    clearDrag();
  };

  // El título de una sesión se resuelve leyendo su transcript, y cerrar la tab es la
  // última chance de hacerlo: después el proceso ya no está para preguntarle.
  const closeTabWithTitleRefresh = async (tabId: string) => {
    const tab = tabs.find((x) => x.id === tabId);
    if (tab) {
      const title = await refreshSessionTitle(tab);
      if (title !== tab.title) updateTab(tab.id, { title });
    }
    closeTab(tabId);
  };

  return (
    <>
      <div
        data-tauri-drag-region
        className="cc-scroll-x flex items-stretch flex-1 min-w-0 h-10
          bg-white/80 dark:bg-gray-900/80 backdrop-blur-md
          border-b border-gray-200 dark:border-gray-800"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (draggedIndex !== null) reorderTabs(draggedIndex, tabs.length - 1);
          clearDrag();
        }}
      >
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
              closeTabWithTitleRefresh(tab.id);
            }}
            onRenameCommit={(title) => renameTab(tab.id, title)}
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverIndex(index);
            }}
            onDrop={() => handleDrop(index)}
            onDragEnd={clearDrag}
            onContextMenu={(e) => setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })}
          />
        ))}

        <button
          onClick={() => setWizardOpen(true)}
          title={t("tabs.new")}
          data-tauri-drag-region="false"
          className="flex items-center justify-center w-9 h-10 shrink-0
            text-gray-400 dark:text-white/30
            hover:text-gray-600 dark:hover:text-white/70
            hover:bg-gray-200/60 dark:hover:bg-white/6
            transition-colors duration-150"
        >
          <AddIcon className="w-5 h-5" />
        </button>

        {/* El resto de la franja es para arrastrar la ventana. */}
        <div className="flex-1 h-full" data-tauri-drag-region />
      </div>

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCloseTab={() => closeTabWithTitleRefresh(contextMenu.tabId)}
        />
      )}

      <NewTabWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConfirm={({ cwd, agent, skillIds, accountId, prelaunch }) => {
          const tabId = addTab({ cwd, agent, accountId, prelaunch });
          navigate("/workspace");

          // Los symlinks de las skills elegidas tienen que existir en el cwd ANTES de que
          // el agente arranque (varias TUIs solo escanean su carpeta al boot) —
          // Terminal.tsx espera esta promesa antes de invocar pty_create.
          registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, skillIds));
        }}
      />
    </>
  );
}
