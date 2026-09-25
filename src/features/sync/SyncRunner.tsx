import { useEffect } from "react";
import { useTheme } from "neogestify-ui-components";

import { useSyncStore } from "./store";

/** Cada cuánto se sincroniza solo mientras la app está abierta. */
const EVERY_MS = 5 * 60_000;
/** Volver a la ventana sincroniza, pero no más seguido que esto. */
const ON_FOCUS_MIN_MS = 60_000;
/** Al abrir, se espera un poco: primero que la app termine de levantar lo suyo. */
const ON_START_MS = 8_000;

/**
 * Mantiene la sincronización al día sin que nadie la pida: al abrir la app, cada
 * {@link EVERY_MS} y al volver a la ventana. Solo si está configurada y en automático.
 * Montado una vez por ventana; el backend serializa las que coincidan.
 */
export function SyncRunner() {
  const { setTheme } = useTheme();
  const load = useSyncStore((s) => s.load);

  useEffect(() => { useSyncStore.setState({ setTheme }); }, [setTheme]);

  useEffect(() => {
    let last = 0;
    const maybeSync = (minGap: number) => {
      const { status, running, sync } = useSyncStore.getState();
      if (!status?.configured || !status.auto || running) return;
      if (Date.now() - last < minGap) return;
      last = Date.now();
      sync().catch(() => {});
    };
    load().catch(() => {});
    const start = setTimeout(() => maybeSync(0), ON_START_MS);
    const every = setInterval(() => maybeSync(0), EVERY_MS);
    const onFocus = () => maybeSync(ON_FOCUS_MIN_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(start);
      clearInterval(every);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return null;
}
