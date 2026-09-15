import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { activateItem, currentLayout } from "@/features/tabs/layout/layoutStore";
import { findGroup } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";
import { tabsOfWorkspace } from "@/features/tabs/workspaceTabs";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { useUiStore } from "@/app/uiStore";

import { WORKSPACE_PATH, matchShortcut, nextTabId, resolveGoto } from "./shortcuts";

/**
 * Engancha los atajos globales. Se monta una sola vez, en `AppShell`.
 *
 * Cada ventana de Tauri tiene su propio webview, así que este listener ya es por ventana
 * sin hacer nada especial: Ctrl+Tab cicla las tabs de la ventana enfocada y de ninguna otra.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcut = matchShortcut(e);
      if (!shortcut) return;

      // Se corta acá SIEMPRE que el acorde sea nuestro, aunque después no haya nada que
      // hacer (ciclar sin tabs): si no, el acorde seguiría viaje hasta la terminal y el
      // agente recibiría un Ctrl+M suelto que no pidió nadie.
      e.preventDefault();
      e.stopPropagation();

      // El estado se lee al APRETAR, no al montar: así el handler se registra una sola vez
      // en vez de volver a suscribirse cada vez que se abre o se cierra una tab.
      const { tabs, activeTabId, activateTab } = useTabsStore.getState();

      if (shortcut.action.kind === "openSettings") {
        // Interruptor, igual que los de sección: si ya está abierto, se cierra.
        const { settingsOpen, setSettingsOpen } = useUiStore.getState();
        setSettingsOpen(!settingsOpen);
        return;
      }

      if (shortcut.action.kind === "goto") {
        const target = resolveGoto(shortcut.action.path, location.pathname, tabs.length > 0);
        if (target) navigate(target);
        return;
      }

      // Con grupos, cicla por las tabs del grupo enfocado: son las de la tira donde se
      // está trabajando, igual que en VS Code.
      const layout = currentLayout();
      const group = layout ? findGroup(layout, layout.focused) : undefined;
      if (group) {
        const key = nextTabId(group.items, group.active, shortcut.action.delta);
        if (key) activateItem(key);
        navigate(WORKSPACE_PATH);
        return;
      }

      // Cicla dentro del workspace, no por todas las tabs de la ventana: saltar a una
      // que la barra ni siquiera muestra es cambiar de carpeta a ciegas.
      // Las tabs de archivo y navegador cuentan: están en la misma barra.
      const agentIds = tabsOfWorkspace(tabs, activeTabId).map((t) => t.id);
      const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null;
      const views = useViewTabsStore.getState();
      const viewIds = viewsOfWorkspace(views.views, activeCwd).map((v) => v.id);
      const current = viewIds.includes(views.activeViewId ?? "") ? views.activeViewId : activeTabId;
      const next = nextTabId([...agentIds, ...viewIds], current, shortcut.action.delta);
      if (!next) return;
      if (viewIds.includes(next)) {
        views.activateView(next);
      } else {
        activateTab(next);
        views.showTerminal();
      }
      // Cambiar de tab sin mostrarla sería cambiar a ciegas: si estabas en una sección, el
      // atajo te lleva a la terminal de la tab a la que acabás de moverte.
      navigate(WORKSPACE_PATH);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigate, location.pathname]);
}
