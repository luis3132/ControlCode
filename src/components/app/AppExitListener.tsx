import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExitConfirmDialog } from "./ExitConfirmDialog";

/**
 * Escucha `cc-app-exit-requested`, emitido desde Rust (RunEvent::ExitRequested) cuando
 * el SO intenta cerrar la app entera (ej. Alt+F4, Cmd+Q, cerrar la última ventana) mientras
 * hay varias ventanas abiertas. Montado en AppShell, vive en todas las ventanas.
 *
 * Nota: el botón de cerrar custom del TopBar (sin decoraciones nativas) NO pasa por aquí —
 * ese caso se resuelve directamente en TopBar.tsx, ya que cerrar una ventana cualquiera
 * mientras otras siguen abiertas no dispara ExitRequested (solo se dispara al intentar
 * salir del proceso completo).
 */
export function AppExitListener() {
  const { t } = useTranslation();
  const [windowCount, setWindowCount] = useState<number | null>(null);

  useEffect(() => {
    const unlisten = listen<number>("cc-app-exit-requested", (event) => {
      setWindowCount(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  if (windowCount === null) return null;

  return (
    <ExitConfirmDialog
      title={t("app.exit.title")}
      body={t("app.exit.body", { count: windowCount })}
      onCancel={() => setWindowCount(null)}
      onCloseAll={() => invoke("confirm_exit_all").catch(console.error)}
      onCloseCurrent={() => {
        setWindowCount(null);
        invoke("close_and_forget_window", { label: getCurrentWindow().label }).catch(console.error);
      }}
    />
  );
}
