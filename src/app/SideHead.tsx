import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { PanelIcon } from "@/app/icons";
import { WindowLights } from "@/app/WindowLights";
import { WorkspaceChip } from "@/app/WorkspaceChip";

const HEAD_BUTTON = `cc-t flex items-center justify-center w-6.5 h-6.5 rounded-lg shrink-0
  text-gray-400 dark:text-white/35
  hover:text-gray-700 dark:hover:text-white
  hover:bg-gray-200 dark:hover:bg-white/10 p-0`;

/**
 * El encabezado del lateral izquierdo: controles de ventana y plegar.
 *
 * Mide exactamente lo mismo que el riel más el panel de abajo, así la división vertical es
 * una sola línea de arriba a abajo.
 *
 * Lleva el selector de workspace (`WorkspaceChip`): dice dónde se está trabajando, arriba de
 * las carpetas de ese workspace.
 */
export function SideHead({ width }: { width: number }) {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.workspacesCollapsed);
  const toggle = useUiStore((s) => s.toggleWorkspaces);

  return (
    // El z-index no es paranoia: la tira de tabs es el vecino de al lado y se le montaba
    // encima a los botones de ventana. Con esto el encabezado siempre pinta arriba, y el
    // `overflow-hidden` evita que lo suyo se derrame sobre ella.
    <div
      data-tauri-drag-region
      style={{ width, position: "relative", zIndex: 30 }}
      className={`flex items-center h-9 shrink-0 overflow-hidden
        bg-gray-100 dark:bg-[#080b0f]
        border-r border-gray-200 dark:border-white/7
        select-none transition-[width] duration-150
        ${collapsed
          // Plegado solo queda el botón (los de ventana se mudan a la barra de tabs),
          // centrado en los 48px de la columna. Sin borde: encima del riel, que es del
          // mismo color, se leen como una sola pieza.
          ? "justify-center gap-0 px-0"
          : "gap-1 pl-3.5 pr-1.5 border-b border-gray-200 dark:border-white/7"}`}
    >
      {!collapsed && <WindowLights />}
      {/* El workspace de esta ventana, arriba de sus carpetas. Plegado, se muda al riel. */}
      {!collapsed && (
        <div className="flex-1 min-w-0 flex items-center pl-1" data-tauri-drag-region>
          <WorkspaceChip />
        </div>
      )}

      <Tooltip content={collapsed ? t("panel.expand") : t("panel.collapse")} placement={collapsed ? "right" : "bottom"}>
        <Button variant="icon"
          onClick={toggle}
          aria-label={collapsed ? t("panel.expand") : t("panel.collapse")}
          data-tauri-drag-region="false"
          className={HEAD_BUTTON}
        >
          <PanelIcon className="w-3.5 h-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}
