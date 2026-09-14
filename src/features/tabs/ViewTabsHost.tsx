import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { BrowserTab } from "@/features/browser/BrowserTab";
import { DiffTab } from "@/features/editor/DiffTab";
import { FileTab } from "@/features/editor/FileTab";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

/**
 * Donde se dibujan las tabs de archivo, diff y navegador: encima de las terminales.
 *
 * Una vez abiertas quedan montadas, igual que las terminales, y solo la activa se ve: un
 * navegador que se desmonta pierde la página y su estado; un editor, el deshacer y el
 * cursor. Pero se montan recién la primera vez que se muestran — las que se restauran al
 * abrir la app están en la barra sin cargar nada hasta que alguien las mira.
 */
export function ViewTabsHost() {
  const views = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
  const onWorkspace = useLocation().pathname.startsWith("/workspace");

  // Una tab de otro workspace nunca se muestra, aunque haya quedado marcada como activa.
  const active = views.find((v) => v.id === activeViewId && activeCwd !== null
    && comparablePath(v.cwd) === comparablePath(activeCwd)) ?? null;

  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (active && !seen.has(active.id)) setSeen((prev) => new Set(prev).add(active.id));
  }, [active, seen]);

  if (views.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        visibility: active ? undefined : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      {views.map((view) => {
        const isActive = view.id === active?.id;
        if (!isActive && !seen.has(view.id)) return null;
        return (
          <div key={view.id} style={{ position: "absolute", inset: 0, visibility: isActive ? undefined : "hidden" }}>
            {view.kind === "file" && <FileTab view={view} active={isActive && onWorkspace} />}
            {view.kind === "diff" && <DiffTab view={view} active={isActive && onWorkspace} />}
            {view.kind === "browser" && <BrowserTab view={view} active={isActive && onWorkspace} />}
          </div>
        );
      })}
    </div>
  );
}
