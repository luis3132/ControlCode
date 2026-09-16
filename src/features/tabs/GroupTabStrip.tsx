import { Fragment, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { agentPaint } from "@/features/browser/agentPaint";
import { activateItem, useLayoutStore } from "@/features/tabs/layout/layoutStore";
import { isAgentKey, keyId } from "@/features/tabs/layout/layoutTree";
import { beginTabDrag } from "@/features/tabs/layout/tabDrag";
import { useTabsStore } from "@/features/tabs/store";
import { openTabMenu, requestCloseItem } from "@/features/tabs/tabActions";
import { TabItem } from "@/features/tabs/TabItem";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { viewLabels, viewsOfWorkspace } from "@/features/tabs/viewTabs";
import { ViewTabItem } from "@/features/tabs/ViewTabItem";

/**
 * Las tabs de un grupo, en su orden: la tira de la barra de título cuando no hay división, o
 * la del encabezado de cada grupo cuando la hay. Solo las tabs; el contenedor —que marca
 * `data-tab-strip` para que se pueda soltar ahí— y los botones de alrededor los pone quien
 * la usa.
 */
export function GroupTabStrip({ items, active, groupFocused, draggable }: {
  items: string[];
  active: string | null;
  /** En el grupo que no tiene el foco, la tab visible se marca más apagada. */
  groupFocused: boolean;
  /** Sin árbol todavía (las tabs cargando) no hay adónde soltar. */
  draggable: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const renameTab = useTabsStore((s) => s.renameTab);
  const views = useViewTabsStore((s) => s.views);
  const dragging = useLayoutStore((s) => s.drag?.key ?? null);

  const byId = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const mine = useMemo(() => {
    const ids = new Set(items.filter((k) => !isAgentKey(k)).map(keyId));
    return views.filter((v) => ids.has(v.id));
  }, [items, views]);
  // Las pistas de carpeta se calculan sobre las del workspace entero y no solo sobre las de
  // este grupo: dos `index.ts` en grupos distintos siguen siendo confundibles.
  const workspaceViews = useMemo(() => viewsOfWorkspace(views, mine[0]?.cwd ?? null), [mine, views]);
  const labels = useMemo(() => viewLabels(workspaceViews), [workspaceViews]);
  const viewsById = useMemo(() => new Map(mine.map((v) => [v.id, v])), [mine]);

  // Qué agentes de esta ventana están manejando un navegador. Se mira sobre TODAS las
  // vistas y no solo sobre las de este grupo: el agente y su navegador se pueden arrastrar
  // a grupos distintos, y ahí el color es lo único que los sigue atando.
  const driving = useMemo(
    () => new Set(views.flatMap((v) => (v.kind === "browser" && v.owner ? [v.owner.id] : []))),
    [views]
  );

  // La activa siempre a la vista: abrir un archivo en una tira llena lo dejaba escondido al
  // final, y no había forma de saber que se había abierto.
  useEffect(() => {
    if (!active) return;
    for (const el of document.querySelectorAll<HTMLElement>(`[data-tab-key="${CSS.escape(active)}"]`)) {
      const strip = el.closest<HTMLElement>(".cc-scroll-x");
      if (!strip) continue;
      // Los botones del grupo quedan fijos encima del final de la tira.
      const covered = strip.querySelector<HTMLElement>("[data-strip-actions]")?.offsetWidth ?? 0;
      const box = strip.getBoundingClientRect();
      const tab = el.getBoundingClientRect();
      if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left;
      else if (tab.right > box.right - covered) strip.scrollLeft += tab.right - (box.right - covered);
    }
  }, [active, items]);

  const activate = (key: string) => {
    activateItem(key);
    navigate("/workspace");
  };

  return (
    <>
      {items.map((key, i) => {
        // Entre los agentes y lo que se abrió, una raya: son dos clases de tab.
        const separator = i > 0 && isAgentKey(items[i - 1]!) && !isAgentKey(key);
        const faded = dragging === key ? "opacity-40" : "";
        if (isAgentKey(key)) {
          const tab = byId.get(keyId(key));
          if (!tab) return null;
          return (
            <TabItem
              key={key}
              tabKey={key}
              className={faded}
              tab={tab}
              paint={driving.has(tab.id) ? agentPaint(tab.id) : null}
              paintHint={driving.has(tab.id) ? t("browser.driving") : undefined}
              isActive={key === active}
              groupFocused={groupFocused}
              onActivate={() => activate(key)}
              onClose={(e) => {
                e.stopPropagation();
                requestCloseItem(key);
              }}
              onRenameCommit={(title) => renameTab(tab.id, title)}
              onPointerDown={draggable ? (e) => beginTabDrag(e, key, tab.title) : undefined}
              onContextMenu={(e) => openTabMenu(key, e.clientX, e.clientY)}
            />
          );
        }
        const view = viewsById.get(keyId(key));
        if (!view) return null;
        const title = view.title || (view.kind === "browser" ? t("browser.newTab") : "");
        return (
          <Fragment key={key}>
            {separator && <span className="shrink-0 self-center w-px h-4 mx-1 bg-gray-300 dark:bg-white/10" />}
            <ViewTabItem
              tabKey={key}
              className={faded}
              view={view}
              hint={labels.get(view.id)?.hint ?? null}
              paint={view.kind === "browser" && view.owner ? agentPaint(view.owner.id) : null}
              paintHint={
                view.kind === "browser" && view.owner
                  ? t("browser.ownedBy", { agent: view.owner.label })
                  : undefined
              }
              isActive={key === active}
              groupFocused={groupFocused}
              onActivate={() => activate(key)}
              onClose={() => requestCloseItem(key)}
              onPointerDown={draggable ? (e) => beginTabDrag(e, key, title) : undefined}
              onContextMenu={(e) => openTabMenu(key, e.clientX, e.clientY)}
            />
          </Fragment>
        );
      })}
    </>
  );
}
