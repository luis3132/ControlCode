import { useEffect, useState } from "react";

import { repoInfo } from "@/features/explorer/ipc";
import type { RepoInfo } from "@/features/explorer/types";

const UNRESOLVED: RepoInfo = {
  root: null, branch: null, isWorktree: false, changes: {}, changedCount: 0,
};

/**
 * Resuelve cada `cwd` contra git, una sola vez por carpeta.
 *
 * Cada resolución son un par de invocaciones a `git`, así que se cachean por ruta: sin
 * eso, cada render del panel dispararía tantos procesos como tabs abiertas. El árbol se
 * dibuja con lo que haya y se reacomoda solo cuando llegan las respuestas.
 */
export function useRepoInfo(cwds: string[]): Map<string, RepoInfo> {
  const [cache, setCache] = useState<Map<string, RepoInfo>>(new Map());

  // La clave es el CONTENIDO, no el array: `cwds` se rearma en cada render y comparar la
  // referencia relanzaría el efecto para siempre.
  const key = JSON.stringify([...new Set(cwds)].sort());

  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    const missing = wanted.filter((cwd) => !cache.has(cwd));
    if (missing.length === 0) return;

    let stale = false;
    Promise.all(
      missing.map((cwd) =>
        repoInfo(cwd)
          .then((info) => [cwd, info] as const)
          // Una carpeta que ya no existe (la borraron con la tab abierta) no puede tumbar
          // al resto: se cachea como "sin repo" y el panel la muestra igual.
          .catch(() => [cwd, UNRESOLVED] as const)
      )
    ).then((pairs) => {
      if (stale) return;
      setCache((prev) => {
        const next = new Map(prev);
        for (const [cwd, info] of pairs) next.set(cwd, info);
        return next;
      });
    });

    return () => { stale = true; };
    // `cache` queda fuera a propósito: agregarlo relanzaría el efecto con cada respuesta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return cache;
}

/** "4m", "2h", "3d" — la edad de una tab, corta como para caber al lado del título. */
export function elapsed(since: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
