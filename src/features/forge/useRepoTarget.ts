import { useCallback, useEffect, useState } from "react";

import { forgeRepo } from "./ipc";
import { useForgeStore } from "./store";
import { forgeErrorOf, type ForgeError, type RepoTarget } from "./types";

/**
 * El repo del workspace en la nube: host, `owner/repo` y con qué cuenta. Se vuelve a leer
 * cuando cambian las cuentas: iniciar sesión desde otro lado tiene que verse acá sin
 * recargar nada.
 *
 * `undefined` mientras carga, `null` si no hay repo o no tiene remoto.
 */
export function useRepoTarget(cwd: string | null) {
  const accounts = useForgeStore((s) => s.accounts);
  const loaded = useForgeStore((s) => s.loaded);
  const load = useForgeStore((s) => s.load);
  const [target, setTarget] = useState<RepoTarget | null | undefined>(undefined);
  const [error, setError] = useState<ForgeError | null>(null);

  useEffect(() => { if (!loaded) load().catch(console.error); }, [loaded, load]);

  const reload = useCallback(async () => {
    if (!cwd) { setTarget(null); return; }
    try {
      setTarget(await forgeRepo(cwd));
      setError(null);
    } catch (e) {
      setError(forgeErrorOf(e));
      setTarget(null);
    }
  }, [cwd]);

  // `accounts` en las dependencias a propósito: es la señal de "cambió quién está logueado".
  useEffect(() => { setTarget(undefined); reload(); }, [reload, accounts]);

  return { target, error, reload };
}
