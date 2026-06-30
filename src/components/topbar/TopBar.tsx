import { useEffect, useState } from "react";
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
} from "neogestify-ui-components";
import { useTabsStore } from "../../store/tabs";
import { SaveWorkspaceDialog } from "../workspace/SaveWorkspaceDialog";
import { ExitConfirmDialog } from "../app/ExitConfirmDialog";

const NAV_ITEMS = [
  { id: "home", Icon: HomeIcon, labelKey: "sidebar.home", path: "/" },
  { id: "sessions", Icon: ClockIcon, labelKey: "sidebar.sessions", path: null },
  { id: "skills", Icon: StackIcon, labelKey: "sidebar.skills", path: null },
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
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);

  const handleCloseClick = async () => {
    const labels = await invoke<string[]>("get_window_labels").catch(() => []);
    if (labels.length > 1) {
      setExitWindowCount(labels.length);
    } else {
      getCurrentWindow().close();
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
        className="flex items-center h-11 w-full shrink-0 justify-between pl-2
        bg-white/80 dark:bg-gray-900/80 backdrop-blur-md
        border-b border-gray-200 dark:border-gray-800
        shadow-sm transition-colors duration-300 select-none"
      >
        {/* Logo — sin drag-region para que el click funcione */}
        <div className="flex items-center" data-tauri-drag-region="false">
          <Button
            variant="link"
            onClick={() => navigate("/")}
            className="hover:opacity-80 transition-opacity"
          >
            <span className="text-sm font-bold bg-clip-text text-transparent
            bg-linear-to-r from-blue-600 to-violet-600
            dark:from-blue-400 dark:to-violet-400">
              Control Code
            </span>
          </Button>
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
          {/* Settings + ThemeToggle */}
          <div className="flex items-center gap-1 pr-2" data-tauri-drag-region="false">
            {hasTabs && (
              <Button
                variant="toggle"
                title={t("topbar.saveWorkspace")}
                onClick={() => setShowSaveWorkspace(true)}
              >
                <SaveIcon className="w-4 h-4" />
              </Button>
            )}
            <ThemeToggle />
            <Button
              variant="toggle"
              title={t("sidebar.settings")}
              onClick={() => navigate("/settings")}
              isActive={location.pathname === "/settings"}
            >
              <GearIcon className="w-4 h-4" />
            </Button>
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

      {exitWindowCount !== null && (
        <ExitConfirmDialog
          windowCount={exitWindowCount}
          onCancel={() => setExitWindowCount(null)}
          onCloseAll={() => invoke("confirm_exit_all").catch(console.error)}
          onCloseCurrent={() => {
            setExitWindowCount(null);
            getCurrentWindow().close().catch(console.error);
          }}
        />
      )}
    </>
  );
}
