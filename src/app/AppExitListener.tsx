import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ExitConfirmDialog } from "@/app/ExitConfirmDialog";
import { ClosingProgress, closeWindowWithSave, exitAllWithSave, installCloseListeners } from "@/app/closeWithSave";

/**
 * Escucha `cc-app-exit-requested`, emitido desde Rust (RunEvent::ExitRequested) cuando
 * el SO intenta cerrar la app entera (ej. Alt+F4, Cmd+Q, cerrar la última ventana) mientras
 * hay varias ventanas abiertas. Montado en AppShell, vive en todas las ventanas.
 *
 * Nota: el botón de cerrar propio (`WindowLights`, la ventana es sin decoración) NO pasa
 * por aquí — cierra su ventana directo, porque cerrar una cualquiera mientras otras siguen
 * abiertas no dispara ExitRequested (solo se dispara al intentar salir del proceso).
 *
 * Acá también viven los oyentes del cierre con guardado (ver `closeWithSave`): el cierre
 * que pide el sistema para esta ventana, y el "guardá lo tuyo" de un "cerrar todo".
 */
export function AppExitListener() {
  const { t } = useTranslation();
  const [windowCount, setWindowCount] = useState<number | null>(null);

  useEffect(() => installCloseListeners(), []);

  useEffect(() => {
    const unlisten = listen<number>("cc-app-exit-requested", (event) => {
      setWindowCount(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  return (
    <>
      <ClosingProgress />
      {windowCount !== null && (
        <ExitConfirmDialog
          title={t("app.exit.title")}
          body={t("app.exit.body", { count: windowCount })}
          onCancel={() => setWindowCount(null)}
          onCloseAll={() => {
            setWindowCount(null);
            exitAllWithSave().catch(console.error);
          }}
          onCloseCurrent={() => {
            setWindowCount(null);
            closeWindowWithSave("button").catch(console.error);
          }}
        />
      )}
    </>
  );
}
