import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BoxIcon, HomeIcon, SaveIcon } from "neogestify-ui-components";

import { useUiStore } from "@/app/uiStore";
import { PanelIcon } from "@/app/icons";
import { WindowLights } from "@/app/WindowLights";
import { useTabsStore } from "@/features/tabs/store";
import { DEFAULT_WORKSPACE_ID } from "@/features/tabs/types";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { SaveWorkspaceDialog } from "@/features/workspaces/SaveWorkspaceDialog";
import { ResetDefaultDialog } from "@/features/workspaces/ResetDefaultDialog";
import { defaultWorkspaceHasContent } from "@/features/workspaces/ipc";

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left
        text-gray-700 dark:text-gray-200
        hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * El encabezado del lateral izquierdo: controles de ventana, nombre y toggle del panel.
 *
 * Los controles viven acá y no a la derecha de la barra de título para que esa barra
 * quede SOLO con las tabs. Mide exactamente lo mismo que el riel más el panel de abajo,
 * así la división vertical es una sola línea de arriba a abajo.
 */
export function SideHead({ width }: { width: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const collapsed = useUiStore((s) => s.workspacesCollapsed);
  const toggle = useUiStore((s) => s.toggleWorkspaces);
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // El bucket "default" nunca se guarda con nombre: "Nuevo workspace" simplemente lo
  // vacía y abre una ventana en blanco ahí. Si tiene tabs sin guardar, primero advierte.
  const handleNewWorkspace = async () => {
    setMenuOpen(false);
    const hasContent = await defaultWorkspaceHasContent().catch(() => false);
    if (hasContent) setShowReset(true);
    else await resetDefaultWorkspace().catch(console.error);
  };

  return (
    <>
      {/* El z-index no es paranoia: la tira de tabs es el vecino de al lado y se le
          montaba encima a los botones de ventana. Con esto el encabezado siempre pinta
          arriba, y el `overflow-hidden` evita que lo suyo se derrame sobre ella. */}
      <div
        data-tauri-drag-region
        style={{ width, position: "relative", zIndex: 30 }}
        className="flex items-center gap-2.5 h-10 shrink-0 overflow-hidden pl-3.5 pr-1.5
          bg-gray-100 dark:bg-[#080b0f]
          border-r border-b border-gray-200 dark:border-white/7
          select-none transition-[width] duration-150"
      >
        {!collapsed && <WindowLights />}

        {!collapsed && (
          <div className="relative min-w-0" data-tauri-drag-region="false" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="text-[12.5px] font-bold tracking-tight truncate
                bg-clip-text text-transparent
                bg-linear-to-r from-blue-600 to-violet-600
                dark:from-blue-400 dark:to-violet-400
                hover:opacity-80 transition-opacity"
            >
              Control Code
            </button>

            {menuOpen && (
              <div className="absolute top-full left-0 mt-1.5 w-56 py-1 z-100
                rounded-lg border border-gray-200 dark:border-gray-700
                bg-white dark:bg-gray-800 shadow-lg">
                <MenuItem
                  icon={<HomeIcon className="w-4 h-4 shrink-0" />}
                  label={t("topbar.menu.home")}
                  onClick={() => { setMenuOpen(false); navigate("/"); }}
                />
                <MenuItem
                  icon={<BoxIcon className="w-4 h-4 shrink-0" />}
                  label={t("topbar.menu.newWorkspace")}
                  onClick={handleNewWorkspace}
                />
                {hasTabs && workspaceId === DEFAULT_WORKSPACE_ID && (
                  <MenuItem
                    icon={<SaveIcon className="w-4 h-4 shrink-0" />}
                    label={t("topbar.saveWorkspace")}
                    onClick={() => { setMenuOpen(false); setShowSave(true); }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        <button
          onClick={toggle}
          title={collapsed ? t("panel.expand") : t("panel.collapse")}
          data-tauri-drag-region="false"
          className="flex items-center justify-center w-6.5 h-6.5 rounded-lg shrink-0
            text-gray-400 dark:text-white/35
            hover:text-gray-700 dark:hover:text-white
            hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
        >
          <PanelIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {showSave && <SaveWorkspaceDialog onClose={() => setShowSave(false)} />}
      {showReset && <ResetDefaultDialog onClose={() => setShowReset(false)} />}
    </>
  );
}
