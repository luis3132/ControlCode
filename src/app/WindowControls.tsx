import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

/**
 * Minimizar / maximizar / cerrar.
 *
 * Son propios y no los del sistema porque la ventana es sin decoración (ver
 * `tauri.conf.json`): el header ES la barra de título.
 */
export function WindowControls({
  workspaceWindowCount,
  onClose,
}: {
  /** Cuántas ventanas tiene AHORA el workspace — el tooltip delata que el click va a
   *  preguntar en vez de cerrar de una. */
  workspaceWindowCount: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const win = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [win]);

  const buttonClass = `flex items-center justify-center w-9 h-11
    text-gray-400 dark:text-gray-500
    hover:bg-gray-100 dark:hover:bg-white/10
    hover:text-gray-700 dark:hover:text-white
    transition-colors duration-150`;

  return (
    <div className="flex items-center" data-tauri-drag-region="false">
      <button onClick={() => win.minimize()} title="Minimizar" className={buttonClass}>
        <MinimizeIcon />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={isMaximized ? "Restaurar" : "Maximizar"}
        className={buttonClass}
      >
        <MaximizeIcon isMaximized={isMaximized} />
      </button>
      <button
        onClick={onClose}
        title={
          workspaceWindowCount > 1
            ? t("workspace.close.choose", { count: workspaceWindowCount })
            : t("workspace.close.window")
        }
        className="flex items-center justify-center w-9 h-11 rounded-tr-none
          text-gray-400 dark:text-gray-500
          hover:bg-red-500 hover:text-white
          transition-colors duration-150"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
