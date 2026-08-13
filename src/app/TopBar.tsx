import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, ThemeToggle } from "neogestify-ui-components";
import {
  HomeIcon,
  ClockIcon,
  StackIcon,
  CloudIcon,
  GearIcon,
  SaveIcon,
  AddIcon,
  BoxIcon,
} from "neogestify-ui-components";
import { useTabsStore } from "@/features/tabs/store";
import { DEFAULT_WORKSPACE_ID } from "@/features/tabs/types";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { SaveWorkspaceDialog } from "@/features/workspaces/SaveWorkspaceDialog";
import { ResetDefaultDialog } from "@/features/workspaces/ResetDefaultDialog";
import { ExitConfirmDialog } from "@/app/ExitConfirmDialog";
import { WindowControls } from "@/app/WindowControls";
import { OrchestratorIndicator } from "@/features/orchestrator/OrchestratorIndicator";
import {
  closeWorkspaceWindows,
  defaultWorkspaceHasContent,
  getWorkspace,
  liveWindowCount,
} from "@/features/workspaces/ipc";
import { closeAndForgetWindow, openNewWindow } from "@/shared/ipc/window";

const NAV_ITEMS = [
  { id: "home", Icon: HomeIcon, labelKey: "sidebar.home", path: "/" },
  { id: "sessions", Icon: ClockIcon, labelKey: "sidebar.sessions", path: "/sessions" },
  { id: "skills", Icon: StackIcon, labelKey: "sidebar.skills", path: "/skills" },
  { id: "marketplace", Icon: CloudIcon, labelKey: "sidebar.marketplace", path: "/marketplace" },
] as const;

// Iconos SVG para los controles de ventana
export function TopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [showSaveWorkspace, setShowSaveWorkspace] = useState(false);
  const [exitWindowCount, setExitWindowCount] = useState<number | null>(null);
  const [workspaceWindowCount, setWorkspaceWindowCount] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showResetWarning, setShowResetWarning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  // Nombre del workspace de ESTA ventana (reemplaza el "Control Code" estático del logo).
  // Guard contra respuestas fuera de orden: si `workspaceId` cambia dos veces rápido, la
  // resolución del valor viejo puede llegar después de la del nuevo y pisarlo.
  useEffect(() => {
    let stale = false;
    getWorkspace(workspaceId)
      .then((ws) => { if (!stale) setWorkspaceName(ws.name); })
      .catch(() => { if (!stale) setWorkspaceName(null); });
    return () => { stale = true; };
  }, [workspaceId]);

  // Cuántas ventanas vivas tiene el workspace de ESTA ventana. Se mantiene al día en
  // tiempo real: el backend emite `cc-workspace-changed` al crear una ventana y al
  // destruirla, así que abrir un tear-off o cerrar una ventana hermana actualiza este
  // número en todas las demás al instante — sin eso, el botón de cerrar seguía ofreciendo
  // "cerrar todo el workspace" cuando ya quedaba una sola ventana, y al revés.
  useEffect(() => {
    let stale = false;
    const refresh = () =>
      liveWindowCount(workspaceId)
        .then((count) => { if (!stale) setWorkspaceWindowCount(count); })
        .catch(() => { if (!stale) setWorkspaceWindowCount(1); });

    refresh();
    const unlisten = listen("cc-workspace-changed", refresh);
    return () => {
      stale = true;
      unlisten.then((off) => off());
    };
  }, [workspaceId]);

  const handleCloseClick = () => {
    // Escalado al workspace de ESTA ventana, no a todas las ventanas de la app — si
    // hay otro workspace abierto en paralelo (vía "mantener actuales" al cambiar de
    // workspace), cerrar acá no debe tocarlo.
    if (workspaceWindowCount > 1) {
      setExitWindowCount(workspaceWindowCount);
    } else {
      closeAndForgetWindow(getCurrentWindow().label).catch(console.error);
    }
  };

  // Cierra el menú del logo al clickear afuera.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Hereda el workspace de esta ventana: si ya pertenece a un workspace guardado,
  // la nueva ventana queda agrupada con ella la próxima vez que se guarde.
  const handleNewWindow = async () => {
    setMenuOpen(false);
    localStorage.setItem("cc-new-window-workspace", workspaceId);
    await openNewWindow(`cc-window-${Date.now()}`).catch(console.error);
  };

  // El bucket "default" nunca se guarda con nombre: "Nuevo workspace" simplemente lo
  // vacía (cierra sus ventanas, borra lo que tenía) y abre una ventana en blanco ahí.
  // Si tiene tabs sin guardar, primero se advierte (ResetDefaultDialog); si está vacío,
  // se resetea directo sin molestar.
  const handleNewWorkspace = async () => {
    setMenuOpen(false);
    const hasContent = await defaultWorkspaceHasContent().catch(() => false);
    if (hasContent) {
      setShowResetWarning(true);
    } else {
      await resetDefaultWorkspace().catch(console.error);
    }
  };


  return (
    <>
      <header
        data-tauri-drag-region
        className="relative z-20 flex items-center h-11 w-full shrink-0 justify-between pl-2
        bg-white/80 dark:bg-gray-900/80 backdrop-blur-md
        border-b border-gray-200 dark:border-gray-800
        shadow-sm transition-colors duration-300 select-none"
      >
        {/* Logo — sin drag-region para que el click funcione. Click abre un menú con
            acciones de ventana/workspace en vez de navegar directo a Home. */}
        <div className="relative flex items-center" data-tauri-drag-region="false" ref={menuRef}>
          <Button
            variant="link"
            onClick={() => setMenuOpen((v) => !v)}
            className="hover:opacity-80 transition-opacity"
          >
            <span className="text-sm font-bold bg-clip-text text-transparent
            bg-linear-to-r from-blue-600 to-violet-600
            dark:from-blue-400 dark:to-violet-400">
              {workspaceName ?? "Control Code"}
            </span>
          </Button>

          {menuOpen && (
            <div className="absolute top-full left-0 mt-1 w-56 py-1 z-100
              rounded-lg border border-gray-200 dark:border-gray-700
              bg-white dark:bg-gray-800 shadow-lg">
              <button
                onClick={() => { setMenuOpen(false); navigate("/"); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                  text-gray-700 dark:text-gray-200
                  hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                <HomeIcon className="w-4 h-4 shrink-0" />
                {t("topbar.menu.home")}
              </button>
              <div className="h-px my-1 bg-gray-200 dark:bg-gray-700" />
              <button
                onClick={handleNewWindow}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                  text-gray-700 dark:text-gray-200
                  hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                <AddIcon className="w-4 h-4 shrink-0" />
                {t("topbar.menu.newWindow")}
              </button>
              <button
                onClick={handleNewWorkspace}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                  text-gray-700 dark:text-gray-200
                  hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                <BoxIcon className="w-4 h-4 shrink-0" />
                {t("topbar.menu.newWorkspace")}
              </button>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex items-center gap-1 w-min" data-tauri-drag-region="false">
          {NAV_ITEMS.map(({ id, Icon, labelKey, path }) => {
            const isActive = path !== null && location.pathname === path;
            const isDisabled = path === null;
            return (
              <Button
                key={id}
                variant="nav"
                title={t(labelKey)}
                disabled={isDisabled}
                onClick={() => path && navigate(path)}
                className={`
                flex items-center gap-1.5 h-7! w-min px-2.5! text-xs! font-medium! transition-all duration-200
                ${isActive
                    ? "bg-gray-100! dark:bg-white/10! text-gray-900! dark:text-white!"
                    : isDisabled
                      ? "text-gray-300! dark:text-white/20! cursor-not-allowed! opacity-60!"
                      : "text-gray-500! dark:text-gray-400! hover:text-gray-900! dark:hover:text-white! hover:bg-gray-100! dark:hover:bg-white/6!"}
              `}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                {t(labelKey)}
              </Button>
            );
          })}
        </nav>

        <div className="flex items-center justify-end gap-1 pr-1">
          {/* Save workspace + Settings + ThemeToggle (tema al final) */}
          <div className="flex items-center gap-1 pr-2" data-tauri-drag-region="false">
            {/* Solo se dibuja si la CLI está siendo usada (Fase 9). */}
            <OrchestratorIndicator />
            {hasTabs && workspaceId === DEFAULT_WORKSPACE_ID && (
              <Button
                variant="icon"
                size="sm"
                title={t("topbar.saveWorkspace")}
                onClick={() => setShowSaveWorkspace(true)}
                className="text-gray-400! dark:text-gray-500!
                  hover:text-gray-700! dark:hover:text-white!
                  hover:bg-gray-100! dark:hover:bg-white/10!"
              >
                <SaveIcon className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="icon"
              size="sm"
              title={t("sidebar.settings")}
              onClick={() => navigate("/settings")}
              className={
                location.pathname === "/settings"
                  ? "bg-gray-100! dark:bg-white/10! text-gray-900! dark:text-white!"
                  : "text-gray-400! dark:text-gray-500! hover:text-gray-700! dark:hover:text-white! hover:bg-gray-100! dark:hover:bg-white/10!"
              }
            >
              <GearIcon className="w-4 h-4" />
            </Button>
            <ThemeToggle />
          </div>

          {/* Separador */}
          <div className="w-px h-5 bg-gray-200 dark:bg-white/10 mx-1" data-tauri-drag-region="false" />

          <WindowControls
            workspaceWindowCount={workspaceWindowCount}
            onClose={handleCloseClick}
          />
        </div>
      </header>

      {showSaveWorkspace && (
        <SaveWorkspaceDialog onClose={() => setShowSaveWorkspace(false)} />
      )}

      {showResetWarning && (
        <ResetDefaultDialog onClose={() => setShowResetWarning(false)} />
      )}

      {exitWindowCount !== null && (
        <ExitConfirmDialog
          title={t("workspace.closeAll.title")}
          body={t("workspace.closeAll.body", { count: exitWindowCount })}
          onCancel={() => setExitWindowCount(null)}
          onCloseAll={() => closeWorkspaceWindows(workspaceId).catch(console.error)}
          onCloseCurrent={() => {
            setExitWindowCount(null);
            closeAndForgetWindow(getCurrentWindow().label).catch(console.error);
          }}
        />
      )}
    </>
  );
}
