import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { BrowserTab } from "@/features/browser/BrowserTab";
import { DiffTab } from "@/features/editor/DiffTab";
import { FileTab } from "@/features/editor/FileTab";
import { focusGroup, placeStyle, usePlacements, type Rect } from "@/features/tabs/layout/layoutStore";
import { viewKey } from "@/features/tabs/layout/layoutTree";
import { useViewTabsStore } from "@/features/tabs/viewStore";

/**
 * Donde se dibujan las tabs de archivo, diff y navegador: encima de las terminales.
 *
 * Una vez abiertas quedan montadas, igual que las terminales, y solo las visibles se ven —
 * una por grupo—: un navegador que se desmonta pierde la página y su estado; un editor, el
 * deshacer y el cursor. Pero se montan recién la primera vez que se muestran — las que se
 * restauran al abrir la app están en la barra sin cargar nada hasta que alguien las mira.
 */
export function ViewTabsHost() {
  const views = useViewTabsStore((s) => s.views);
  const keepMountedIds = useViewTabsStore((s) => s.keepMountedIds);
  const onWorkspace = useLocation().pathname.startsWith("/workspace");
  // Solo las del workspace activo tienen lugar: una de otro nunca se muestra.
  const { visible, focusedItem } = usePlacements();
  const lastRect = useRef(new Map<string, Rect | null>());

  const [seen, setSeen] = useState<Set<string>>(new Set());
  const visibleIds = views.filter((v) => visible.has(viewKey(v.id))).map((v) => v.id);
  const unseen = visibleIds.filter((id) => !seen.has(id)).join("|");
  useEffect(() => {
    if (unseen) setSeen((prev) => new Set([...prev, ...unseen.split("|")]));
  }, [unseen]);

  // Un click adentro de la página de un navegador no le llega a la app: el `<iframe>` se lo
  // queda. Lo que sí se nota es que la ventana pierde el foco y queda en ese `<iframe>`, y
  // con eso se sabe a qué grupo fue.
  const placementsRef = useRef(visible);
  placementsRef.current = visible;
  useEffect(() => {
    const onBlur = () => setTimeout(() => {
      const frame = document.activeElement;
      if (frame?.tagName !== "IFRAME") return;
      const key = frame.closest<HTMLElement>("[data-view-key]")?.dataset.viewKey;
      const groupId = key ? placementsRef.current.get(key)?.groupId : undefined;
      if (groupId) focusGroup(groupId);
    }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  if (views.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" }}>
      {views.map((view) => {
        const key = viewKey(view.id);
        const placement = visible.get(key);
        const shown = placement !== undefined;
        if (!shown && !seen.has(view.id) && !keepMountedIds.includes(view.id)) return null;
        if (placement) lastRect.current.set(key, placement.rect);
        const focused = key === focusedItem && onWorkspace;
        return (
          <div
            key={view.id}
            data-view-key={key}
            style={{
              ...placeStyle(lastRect.current.get(key) ?? null),
              visibility: shown ? undefined : "hidden",
              pointerEvents: shown ? "auto" : "none",
            }}
            onPointerDownCapture={() => placement?.groupId && focusGroup(placement.groupId)}
          >
            {view.kind === "file" && <FileTab view={view} active={shown && onWorkspace} focused={focused} />}
            {view.kind === "diff" && <DiffTab view={view} active={shown && onWorkspace} />}
            {view.kind === "browser" && <BrowserTab view={view} active={focused} />}
          </div>
        );
      })}
    </div>
  );
}
