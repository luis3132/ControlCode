import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AddIcon } from "neogestify-ui-components";

import { WindowLights } from "@/app/WindowLights";
import { GlobeIcon, SplitRightIcon } from "@/app/icons";
import { GroupTabStrip } from "@/features/tabs/GroupTabStrip";
import { splitGroup, useWorkspaceLayout } from "@/features/tabs/layout/layoutStore";
import { agentKey, allGroups, viewKey } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWizard, TabDialogs } from "@/features/tabs/tabActions";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { tabsOfWorkspace } from "@/features/tabs/workspaceTabs";

const BAR_BUTTON = `flex items-center justify-center h-10 shrink-0
  text-gray-400 dark:text-white/30
  hover:text-gray-600 dark:hover:text-white/70
  hover:bg-gray-200/60 dark:hover:bg-white/6
  transition-colors duration-150`;

/**
 * Las tabs del workspace activo, dentro de la barra de título.
 *
 * Solo las de ESE workspace: el workspace es el tab de orden superior y sus agentes son
 * las tabs de adentro. Mostrar las de todas las carpetas a la vez volvía a mezclar lo que
 * el panel izquierdo separa, y con varios proyectos abiertos la barra no entraba.
 *
 * Con la pantalla dividida, cada grupo lleva su propia tira arriba de su contenido (ver
 * `EditorArea`) y acá quedan solo los botones de abrir, que abren en el grupo enfocado.
 */
/** `showLights`: con el panel izquierdo plegado su encabezado queda en 48px y los tres
 *  botones de ventana no entran, así que se mudan acá, al principio de la tira. */
export function TabBar({ showLights = false }: { showLights?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const openBrowser = useViewTabsStore((s) => s.openBrowser);
  const layout = useWorkspaceLayout();

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const groups = layout ? allGroups(layout.root) : [];
  const only = groups.length === 1 ? groups[0]! : null;
  const divided = groups.length > 1;

  // Sin árbol todavía (las tabs cargando) se muestran como siempre: agentes y después vistas.
  const fallbackViews = viewsOfWorkspace(views, activeTab?.cwd ?? null);
  const items = only?.items ?? [
    ...tabsOfWorkspace(tabs, activeTabId).map((tab) => agentKey(tab.id)),
    ...fallbackViews.map((v) => viewKey(v.id)),
  ];
  const fallbackActive = fallbackViews.some((v) => v.id === activeViewId)
    ? viewKey(activeViewId!)
    : activeTab ? agentKey(activeTab.id) : null;

  return (
    <>
      <div
        data-tauri-drag-region
        data-tab-strip={only?.id}
        className="cc-scroll-x flex items-stretch flex-1 min-w-0 h-10
          bg-gray-100 dark:bg-gray-900
          border-b border-gray-200 dark:border-gray-800"
        style={{ position: "relative", zIndex: 0 }}
      >
        {showLights && (
          <div className="flex items-center shrink-0 pl-3.5 pr-2" data-tauri-drag-region>
            <WindowLights />
          </div>
        )}

        {!divided && (
          <GroupTabStrip
            items={items}
            active={only ? only.active : fallbackActive}
            groupFocused
            draggable={only !== null}
          />
        )}

        <button
          // Sin workspace abierto no hay carpeta donde abrir un agente: eso es empezar uno
          // nuevo, y eso vive en Home.
          onClick={() => (activeTab ? openNewAgentWizard() : navigate("/"))}
          title={t("tabs.new")}
          data-tauri-drag-region="false"
          className={`${BAR_BUTTON} w-9`}
        >
          <AddIcon className="w-5 h-5" />
        </button>
        {activeTab && (
          <button
            // Un navegador es del workspace: se abre al lado de sus agentes, para probar lo
            // que están construyendo.
            onClick={() => {
              openBrowser(activeTab.cwd);
              navigate("/workspace");
            }}
            title={t("tabs.newBrowser")}
            data-tauri-drag-region="false"
            className={`${BAR_BUTTON} w-8`}
          >
            <GlobeIcon className="w-4 h-4" />
          </button>
        )}
        {only && (
          <button
            onClick={(e) => {
              splitGroup(only.id, e.altKey ? "down" : "right", only.active);
              navigate("/workspace");
            }}
            title={t("tabs.split.button")}
            data-tauri-drag-region="false"
            className={`${BAR_BUTTON} w-8`}
          >
            <SplitRightIcon className="w-4 h-4" />
          </button>
        )}

        {/* El resto de la franja es para arrastrar la ventana. */}
        <div className="flex-1 h-full" data-tauri-drag-region />
      </div>

      <TabDialogs />
    </>
  );
}
