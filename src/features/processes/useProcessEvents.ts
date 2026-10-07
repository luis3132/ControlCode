import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { PROCS_CHANGED } from "./ipc";
import { useProcessesStore } from "./store";

/**
 * Mantiene la lista de subprocesos al día. Se monta UNA vez por ventana, en `AppShell`:
 * la insignia del riel y el indicador de la barra de estado la necesitan aunque la
 * sección esté cerrada, y un agente lanza o termina procesos en cualquier momento.
 */
export function useProcessEvents() {
  const load = useProcessesStore((s) => s.load);
  useEffect(() => {
    load().catch(console.error);
    const unlisten = listen(PROCS_CHANGED, () => {
      load().catch(console.error);
    });
    return () => { unlisten.then((off) => off()).catch(() => {}); };
  }, [load]);
}
