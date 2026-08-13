import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { useTabsStore } from "@/features/tabs/store";
import { TabItem } from "@/features/tabs/TabItem";
import { TabContextMenu } from "@/features/tabs/TabContextMenu";
import { NewTabWizard } from "@/features/tabs/wizard/NewTabWizard";
import { refreshSessionTitle } from "@/features/sessions/sessionTitle";
import { markPtyTransferring } from "@/features/tabs/ptyTransfer";
import { flushPendingSave } from "@/features/tabs/persistence";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { AddIcon } from "neogestify-ui-components";

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
  otherWindows: string[];
}

export function TabBar() {
  const { t } = useTranslation();
  const { tabs, activeTabId, activateTab, closeTab, renameTab, reorderTabs, addTab, updateTab, workspaceId } =
    useTabsStore();
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const handleDrop = (toIndex: number) => {
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = async (e: React.DragEvent, tabIdx: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    const insideBar = rect &&
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;

    // Soltado dentro del TabBar → reorder (ya manejado por onDrop), nada más
    if (insideBar) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    if (draggedIndex === null) { setDraggedIndex(null); setDragOverIndex(null); return; }

    const tab = tabs[tabIdx];
    if (!tab) { setDraggedIndex(null); setDragOverIndex(null); return; }

    // Coordenadas absolutas del cursor en píxeles físicos (funciona en Wayland)
    const [physX, physY] = await invoke<[number, number]>("get_cursor_position");

    // TopBar (h-10 = 40px lógicos) + TabBar (h-9 = 36px lógicos) = 76px lógicos → físicos
    const scale = window.devicePixelRatio ?? 1;
    const TAB_BAR_PHYSICAL = Math.round(76 * scale);

    // Buscar si el cursor cayó sobre el TabBar de otra ventana
    const bounds = await invoke<Record<string, [number, number, number, number]>>(
      "get_all_window_bounds"
    );
    const myLabel = getCurrentWindow().label;
    let mergeTarget: string | null = null;

    for (const [label, [x, y, w]] of Object.entries(bounds)) {
      if (label === myLabel) continue;
      if (physX >= x && physX <= x + w && physY >= y && physY <= y + TAB_BAR_PHYSICAL) {
        mergeTarget = label;
        break;
      }
    }

    if (mergeTarget) {
      // No mezclar tabs entre ventanas de distintos workspaces por accidente — si el
      // destino pertenece a otro workspace, no se hace merge, pero el drop sigue siendo
      // un detach válido: cae al mismo camino de "nueva ventana" de abajo en vez de no
      // hacer nada (que dejaba la tab sin ningún destino).
      const targetWorkspaceId = await invoke<string | null>("db_get_window_workspace", {
        label: mergeTarget,
      }).catch(() => null);
      if (targetWorkspaceId !== null && targetWorkspaceId !== workspaceId) {
        mergeTarget = null;
      }
    }

    // Solo se cierra la tab de origen si el destino (merge u open_new_window) confirmó
    // éxito — si cualquiera de los dos falla (ventana destino recién cerrada, error del
    // backend), cerrar igual dejaría el PTY vivo huérfano: sin ninguna tab en memoria que
    // lo referencie, invisible para el autosave de cualquier ventana.
    try {
      if (mergeTarget) {
        // Merge: enviar tab (con su PTY vivo) a la otra ventana vía evento Tauri
        await invoke("broadcast_event", {
          event: "cc-receive-tab",
          payload: JSON.stringify({
            targetLabel: mergeTarget,
            cwd: tab.cwd, command: tab.command, agentId: tab.agentId,
            agentLabel: tab.agentLabel, title: tab.title, sessionId: tab.sessionId,
            ptyId: tab.ptyId, accountId: tab.accountId,
          }),
        });
      } else {
        // Fuera de cualquier ventana → nueva ventana, llevándose el mismo PTY. Hereda el
        // workspace de ESTA ventana (misma handoff key que usa TopBar para "Nueva ventana")
        // para que la tab destacada no quede huérfana en el bucket "default".
        localStorage.setItem("cc-detach", JSON.stringify({
          cwd: tab.cwd, command: tab.command, agentId: tab.agentId,
          agentLabel: tab.agentLabel, title: tab.title, sessionId: tab.sessionId,
          ptyId: tab.ptyId, accountId: tab.accountId,
        }));
        localStorage.setItem("cc-new-window-workspace", workspaceId);
        await invoke("open_new_window", { label: `cc-window-${Date.now()}` });
      }
    } catch (err) {
      console.error("No se pudo mover la tab a otra ventana, se conserva en el origen", err);
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    if (tab.ptyId != null) markPtyTransferring(tab.ptyId);
    closeTab(tab.id);
    if (tabs.length === 1) {
      // Sin este flush, la ventana se cierra con el autosave de "sin tabs" todavía
      // pendiente en el debounce — su fila en SQLite queda con la tab que se acaba de
      // mover, duplicada con la copia que ya persistió el destino.
      await flushPendingSave();
      await getCurrentWindow().close();
    }

    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const closeTabWithTitleRefresh = async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      const title = await refreshSessionTitle(tab);
      if (title !== tab.title) updateTab(tab.id, { title });
    }
    closeTab(tabId);
  };

  const handleContextMenu = async (e: React.MouseEvent, tabId: string) => {
    const allLabels = await invoke<string[]>("get_window_labels");
    const myLabel = getCurrentWindow().label;
    const others = allLabels.filter((l) => l !== myLabel);
    setContextMenu({ tabId, x: e.clientX, y: e.clientY, otherWindows: others });
  };

  const handleMoveToWindow = async (targetLabel: string, tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    try {
      await invoke("broadcast_event", {
        event: "cc-receive-tab",
        payload: JSON.stringify({
          targetLabel,
          cwd: tab.cwd,
          command: tab.command,
          agentId: tab.agentId,
          agentLabel: tab.agentLabel,
          title: tab.title,
          sessionId: tab.sessionId,
          ptyId: tab.ptyId,
          accountId: tab.accountId,
        }),
      });
    } catch (err) {
      console.error("No se pudo mover la tab a otra ventana, se conserva en el origen", err);
      return;
    }
    if (tab.ptyId != null) markPtyTransferring(tab.ptyId);
    closeTab(tabId);
    // Auto-cierre si era la última tab. Flush explícito por la misma razón que en
    // handleDragEnd: sin esto, la ventana se cierra con el guardado de "sin tabs"
    // todavía pendiente en el debounce, y su fila queda duplicando la tab movida.
    if (tabs.length === 1) {
      await flushPendingSave();
      await getCurrentWindow().close();
    }
  };

  return (
    <>
      <div
        ref={barRef}
        className="cc-scroll-x flex items-stretch h-10 shrink-0
          bg-gray-100 dark:bg-gray-900
          border-b border-gray-200 dark:border-white/8"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (draggedIndex !== null) reorderTabs(draggedIndex, tabs.length - 1);
          setDraggedIndex(null);
          setDragOverIndex(null);
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
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIndex(index); }}
            onDrop={() => handleDrop(index)}
            onDragEnd={(e) => handleDragEnd(e, index)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          />
        ))}

        <button
          onClick={() => setWizardOpen(true)}
          title={t("tabs.new")}
          className="flex items-center justify-center w-9 h-9 shrink-0
            text-gray-400 dark:text-white/30
            hover:text-gray-600 dark:hover:text-white/70
            hover:bg-gray-200 dark:hover:bg-white/6
            transition-colors duration-150"
        >
          <AddIcon className="w-6 h-6" />
        </button>

        <div className="flex-1 h-full" />
      </div>

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          otherWindows={contextMenu.otherWindows}
          onClose={() => setContextMenu(null)}
          onMoveToWindow={(label) => handleMoveToWindow(label, contextMenu.tabId)}
          onCloseTab={() => closeTabWithTitleRefresh(contextMenu.tabId)}
        />
      )}

      <NewTabWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConfirm={({ cwd, agent, skillIds, accountId, prelaunch }) => {
          const tabId = addTab({ cwd, agent, accountId, prelaunch });
          navigate("/workspace");

          // Los symlinks de las skills elegidas tienen que existir en el cwd ANTES de
          // que el agente arranque (algunos solo escanean su carpeta de skills al
          // boot) — Terminal.tsx espera esta promesa antes de invocar pty_create.
          registerPendingSkillSetup(tabId, attachSkillsToTab(tabId, workspaceId, skillIds));
        }}
      />
    </>
  );
}
