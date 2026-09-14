import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AddIcon, Button } from "neogestify-ui-components";

import { useTabsStore } from "@/features/tabs/store";
import { TabItem } from "@/features/tabs/TabItem";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import { BoxIcon, CloseIcon } from "neogestify-ui-components";
import { NewAgentDialog } from "@/features/tabs/wizard/NewAgentDialog";
import { refreshSessionTitle } from "@/features/sessions/sessionTitle";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { tabsOfWorkspace } from "@/features/tabs/workspaceTabs";
import { WindowLights } from "@/app/WindowLights";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewLabels, viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { ViewTabItem } from "@/features/tabs/ViewTabItem";

/**
 * Las tabs del workspace activo, dentro de la barra de título.
 *
 * Solo las de ESE workspace: el workspace es el tab de orden superior y sus agentes son
 * las tabs de adentro. Mostrar las de todas las carpetas a la vez volvía a mezclar lo que
 * el panel izquierdo separa, y con varios proyectos abiertos la barra no entraba.
 *
 * Arrastrar reordena, y nada más. Sacar una tab para abrir otra ventana ya no existe: se
 * cambia de workspace en el lugar, desde el panel de la izquierda.
 */
/** `showLights`: con el panel izquierdo plegado su encabezado queda en 48px y los tres
 *  botones de ventana no entran, así que se mudan acá, al principio de la tira. */
export function TabBar({ showLights = false }: { showLights?: boolean }) {
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
  // El arrastre se sigue por ID y no por índice: la lista visible es un subconjunto, así
  // que un índice de acá no es el mismo que el que espera `reorderTabs`.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [contextTab, setContextTab] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillScopeTarget | null>(null);

  const visible = tabsOfWorkspace(tabs, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const activateView = useViewTabsStore((s) => s.activateView);
  const closeView = useViewTabsStore((s) => s.closeView);
  const showTerminal = useViewTabsStore((s) => s.showTerminal);
  const workspaceViews = useMemo(() => viewsOfWorkspace(views, activeTab?.cwd ?? null), [views, activeTab?.cwd]);
  const labels = useMemo(() => viewLabels(workspaceViews), [workspaceViews]);
  const activeView = workspaceViews.find((v) => v.id === activeViewId) ?? null;
  /** Una tab con cambios sin guardar que se pidió cerrar: se confirma antes. */
  const [closingDirty, setClosingDirty] = useState<string | null>(null);

  const requestCloseView = (id: string) => {
    const view = views.find((v) => v.id === id);
    if (view?.kind === "file" && view.dirty) setClosingDirty(id);
    else closeView(id);
  };

  const clearDrag = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  const moveTo = (targetId: string) => {
    if (draggedId === null || draggedId === targetId) return clearDrag();
    const from = tabs.findIndex((tab) => tab.id === draggedId);
    const to = tabs.findIndex((tab) => tab.id === targetId);
    if (from >= 0 && to >= 0) reorderTabs(from, to);
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
          bg-gray-100 dark:bg-gray-900
          border-b border-gray-200 dark:border-gray-800"
        style={{ position: "relative", zIndex: 0 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          // Soltar en el vacío = al final de ESTE workspace, no al final de todo.
          const last = visible[visible.length - 1];
          if (last) moveTo(last.id);
          else clearDrag();
        }}
      >
        {showLights && (
          <div className="flex items-center shrink-0 pl-3.5 pr-2" data-tauri-drag-region>
            <WindowLights />
          </div>
        )}

        {visible.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId && !activeView}
            isDragOver={dragOverId === tab.id && draggedId !== tab.id}
            onActivate={() => {
              activateTab(tab.id);
              // Si la tab ya era la activa no cambia nada en el store, y la vista abierta
              // encima seguiría tapando la terminal que se acaba de pedir.
              showTerminal();
              navigate("/workspace");
            }}
            onClose={(e) => {
              e.stopPropagation();
              closeTabWithTitleRefresh(tab.id);
            }}
            onRenameCommit={(title) => renameTab(tab.id, title)}
            onDragStart={() => setDraggedId(tab.id)}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverId(tab.id);
            }}
            onDrop={() => moveTo(tab.id)}
            onDragEnd={clearDrag}
            onContextMenu={(e) => setContextTab({ tabId: tab.id, x: e.clientX, y: e.clientY })}
          />
        ))}

        {workspaceViews.length > 0 && (
          <span className="shrink-0 self-center w-px h-4 mx-1 bg-gray-300 dark:bg-white/10" />
        )}
        {workspaceViews.map((view) => (
          <ViewTabItem
            key={view.id}
            view={view}
            hint={labels.get(view.id)?.hint ?? null}
            isActive={view.id === activeView?.id}
            onActivate={() => {
              activateView(view.id);
              navigate("/workspace");
            }}
            onClose={() => requestCloseView(view.id)}
          />
        ))}

        <button
          // Sin workspace abierto no hay carpeta donde abrir un agente: eso es empezar uno
          // nuevo, y eso vive en Home.
          onClick={() => (activeTab ? setWizardOpen(true) : navigate("/"))}
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

      {contextTab && (() => {
        const tab = tabs.find((x) => x.id === contextTab.tabId);
        if (!tab) return null;
        return (
          <ContextMenu
            x={contextTab.x}
            y={contextTab.y}
            onClose={() => setContextTab(null)}
            items={[
              {
                key: "skills",
                label: t("skills.scope.tabAction"),
                icon: <BoxIcon className="w-4 h-4" />,
                onSelect: () => setSkillTarget({
                  scope: "tab",
                  workspaceId,
                  tabId: tab.id,
                  agentId: tab.agentId,
                  label: tab.title,
                }),
              },
              {
                key: "close",
                label: t("tabs.close"),
                icon: <CloseIcon className="w-4 h-4" />,
                danger: true,
                onSelect: () => closeTabWithTitleRefresh(tab.id),
              },
            ]}
          />
        );
      })()}

      {closingDirty && (
        <AppDialog
          title={t("editor.closeDirty.title")}
          size="sm"
          closeOnEsc
          onClose={() => setClosingDirty(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setClosingDirty(null)}>{t("btn.cancel")}</Button>
              <Button variant="danger" onClick={() => { closeView(closingDirty); setClosingDirty(null); }}>
                {t("editor.closeDirty.confirm")}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("editor.closeDirty.body", { name: views.find((v) => v.id === closingDirty)?.title ?? "" })}
          </p>
        </AppDialog>
      )}

      {skillTarget && (
        <SkillPalette target={skillTarget} onClose={() => setSkillTarget(null)} />
      )}

      <NewAgentDialog
        isOpen={wizardOpen && activeTab !== undefined}
        cwd={activeTab?.cwd ?? ""}
        onClose={() => setWizardOpen(false)}
        onConfirm={({ agent, skillIds, accountId, prelaunch }) => {
          const cwd = activeTab?.cwd;
          if (!cwd) return;
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
