import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
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
import { useTabsStore, DEFAULT_WORKSPACE_ID } from "../../store/tabs";
import { useWorkspacesStore } from "../../store/workspaces";
import { SaveWorkspaceDialog } from "../workspace/SaveWorkspaceDialog";
import { ResetDefaultDialog } from "../workspace/ResetDefaultDialog";
import { ExitConfirmDialog } from "../app/ExitConfirmDialog";

const NAV_ITEMS = [
  { id: "home", Icon: HomeIcon, labelKey: "sidebar.home", path: "/" },
  { id: "sessions", Icon: ClockIcon, labelKey: "sidebar.sessions", path: "/sessions" },
  { id: "skills", Icon: StackIcon, labelKey: "sidebar.skills", path: "/skills" },
  { id: "marketplace", Icon: CloudIcon, labelKey: "sidebar.marketplace", path: null },
] as const;

// Iconos SVG para los controles de ventana
function MinimizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon({ isMaximized }: { isMaximized: boolean }) {
  return isMaximized ? (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="3" y="1" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1 4v5a1 1 0 0 0 1 1h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="1" y="1" width="9" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [isMaximized, setIsMaximized] = useState(false);
  const [showSaveWorkspace, setShowSaveWorkspace] = useState(false);
  const [exitWindowCount, setExitWindowCount] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showResetWarning, setShowResetWarning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const resetDefaultWorkspace = useWorkspacesStore((s) => s.resetDefaultWorkspace);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  // Nombre del workspace de ESTA ventana (reemplaza el "Control Code" estático del logo).
  useEffect(() => {
    invoke<{ name: string }>("db_get_workspace", { workspaceId })
      .then((ws) => setWorkspaceName(ws.name))
      .catch(() => setWorkspaceName(null));
  }, [workspaceId]);

  const handleCloseClick = async () => {
    // Escalado al workspace de ESTA ventana, no a todas las ventanas de la app — si
    // hay otro workspace abierto en paralelo (vía "mantener actuales" al cambiar de
    // workspace), cerrar acá no debe tocarlo.
    const wsWindows = await invoke<unknown[]>("db_get_workspace_windows", { workspaceId }).catch(() => []);
    if (wsWindows.length > 1) {
      setExitWindowCount(wsWindows.length);
    } else {
      invoke("close_and_forget_window", { label: getCurrentWindow().label }).catch(console.error);
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
    await invoke("open_new_window", { label: `cc-window-${Date.now()}` }).catch(console.error);
  };

  // El bucket "default" nunca se guarda con nombre: "Nuevo workspace" simplemente lo
  // vacía (cierra sus ventanas, borra lo que tenía) y abre una ventana en blanco ahí.
  // Si tiene tabs sin guardar, primero se advierte (ResetDefaultDialog); si está vacío,
  // se resetea directo sin molestar.
  const handleNewWorkspace = async () => {
    setMenuOpen(false);
    const hasContent = await invoke<boolean>("default_workspace_has_content").catch(() => false);
    if (hasContent) {
      setShowResetWarning(true);
    } else {
      await resetDefaultWorkspace().catch(console.error);
    }
  };

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);

    let unlisten: (() => void) | undefined;
    win.onResized(async () => {
      setIsMaximized(await win.isMaximized());
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  const win = getCurrentWindow();

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

          {/* Controles de ventana */}
          <div className="flex items-center" data-tauri-drag-region="false">
            <button
              onClick={() => win.minimize()}
              title="Minimizar"
              className="flex items-center justify-center w-9 h-11
            text-gray-400 dark:text-gray-500
            hover:bg-gray-100 dark:hover:bg-white/10
            hover:text-gray-700 dark:hover:text-white
            transition-colors duration-150"
            >
              <MinimizeIcon />
            </button>
            <button
              onClick={() => win.toggleMaximize()}
              title={isMaximized ? "Restaurar" : "Maximizar"}
              className="flex items-center justify-center w-9 h-11
            text-gray-400 dark:text-gray-500
            hover:bg-gray-100 dark:hover:bg-white/10
            hover:text-gray-700 dark:hover:text-white
            transition-colors duration-150"
            >
              <MaximizeIcon isMaximized={isMaximized} />
            </button>
            <button
              onClick={handleCloseClick}
              title="Cerrar"
              className="flex items-center justify-center w-9 h-11 rounded-tr-none
            text-gray-400 dark:text-gray-500
            hover:bg-red-500 hover:text-white
            transition-colors duration-150"
            >
              <CloseIcon />
            </button>
          </div>
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
          onCloseAll={() => invoke("close_workspace_windows", { workspaceId }).catch(console.error)}
          onCloseCurrent={() => {
            setExitWindowCount(null);
            invoke("close_and_forget_window", { label: getCurrentWindow().label }).catch(console.error);
          }}
        />
      )}
    </>
  );
}
