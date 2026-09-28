/**
 * Los PCs emparejados y la clave del teléfono, para toda la app.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { Keys } from "@/protocol/crypto";
import { connectionFor, dropConnection, useSnapshot, type DesktopConnection } from "./connection";
import * as storage from "./storage";
import type { Desktop } from "./types";

interface DesktopsValue {
  ready: boolean;
  keys: Keys | null;
  desktops: Desktop[];
  add: (desktop: Desktop) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const Context = createContext<DesktopsValue | null>(null);

export function DesktopsProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [desktops, setDesktops] = useState<Desktop[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      setKeys(await storage.deviceKeys());
      setDesktops(await storage.listDesktops());
      setReady(true);
    })().catch(console.error);
  }, []);

  const add = useCallback(async (desktop: Desktop) => {
    await storage.saveDesktop(desktop);
    setDesktops(await storage.listDesktops());
  }, []);

  const remove = useCallback(async (id: string) => {
    dropConnection(id);
    await storage.removeDesktop(id);
    setDesktops(await storage.listDesktops());
  }, []);

  const value = useMemo(() => ({ ready, keys, desktops, add, remove }), [ready, keys, desktops, add, remove]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDesktops(): DesktopsValue {
  const value = useContext(Context);
  if (!value) throw new Error("useDesktops fuera de DesktopsProvider");
  return value;
}

/** Un PC, su conexión (ya arrancada) y su estado. */
export function useDesktop(id: string | undefined) {
  const { desktops, keys } = useDesktops();
  const desktop = desktops.find((d) => d.id === id) ?? null;
  const conn: DesktopConnection | null = useMemo(
    () => (desktop && keys ? connectionFor(desktop, keys) : null),
    [desktop, keys],
  );
  const snapshot = useSnapshot(conn);
  return { desktop, conn, snapshot };
}
