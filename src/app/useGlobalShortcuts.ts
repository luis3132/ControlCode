import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useTabsStore } from "@/features/tabs/store";

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

      if (shortcut.action.kind === "goto") {
        const target = resolveGoto(shortcut.action.path, location.pathname, tabs.length > 0);
        if (target) navigate(target);
        return;
      }

      const next = nextTabId(
        tabs.map((t) => t.id),
        activeTabId,
        shortcut.action.delta
      );
      if (!next) return;
      activateTab(next);
      // Cambiar de tab sin mostrarla sería cambiar a ciegas: si estabas en una sección, el
      // atajo te lleva a la terminal de la tab a la que acabás de moverte.
      navigate(WORKSPACE_PATH);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigate, location.pathname]);
}
