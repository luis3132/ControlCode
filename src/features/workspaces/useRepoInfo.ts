import { useEffect, useRef, useState } from "react";

import { repoInfo } from "@/features/explorer/ipc";
import type { RepoInfo } from "@/features/explorer/types";

const UNRESOLVED: RepoInfo = {
  root: null, branch: null, isWorktree: false, changes: {}, changedCount: 0,
};

const invalidators = new Set<(root: string) => void>();

/**
 * Lo último que se supo de cada carpeta, compartido por TODOS los montajes del hook.
 *
 * Sin esto la caché vivía en el estado del componente y moría con él: cada vez que se
 * entraba a Sesiones se volvía a preguntar a git por todas las carpetas del historial, y
 * mientras no contestaban la lista se dibujaba desarmada (cada carpeta como su propio
 * grupo, sin rama) para reacomodarse un instante después. Ahora un montaje nuevo arranca
 * con lo que ya se sabía y lo relee por detrás.
 */
const shared = new Map<string, RepoInfo>();

/**
 * Vuelve a leer lo que se sabía del repo `root`.
 *
 * La caché es por carpeta y para siempre, lo cual está bien mientras nada cambie — pero el
 * panel de control de versiones cambia el repo (commitea, cambia de rama), y sin avisar
 * acá las marcas del árbol y la rama del lateral seguirían mostrando lo de antes.
 *
 * Releer NO borra lo que había: se sigue mostrando hasta que llega lo nuevo. Antes la
 * entrada se borraba, y mientras volvía la respuesta el panel creía que la carpeta no era
 * un repo — "sin repo", los grupos desarmados — y un instante después volvía todo. Con un
 * agente trabajando eso pasaba cada pocos segundos.
 */
export function invalidateRepoInfo(root: string) {
  invalidators.forEach((invalidate) => invalidate(root));
}

/** Si `cwd` está en el repo `root` (o es esa carpeta). */
export function belongs(cwd: string, info: RepoInfo | undefined, root: string): boolean {
  return info?.root === root || cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
}

/** Suma las respuestas a la caché. Si nada cambió devuelve la MISMA caché: releer el repo
 *  cada pocos segundos no puede redibujar el panel entero cada vez. */
export function mergeRepoInfo(
  prev: Map<string, RepoInfo>,
  pairs: ReadonlyArray<readonly [string, RepoInfo]>
): Map<string, RepoInfo> {
  let next: Map<string, RepoInfo> | null = null;
  for (const [cwd, info] of pairs) {
    if (JSON.stringify(prev.get(cwd)) === JSON.stringify(info)) continue;
    next ??= new Map(prev);
    next.set(cwd, info);
  }
  return next ?? prev;
}

/**
 * Resuelve cada `cwd` contra git, una sola vez por carpeta.
 *
 * Cada resolución son un par de invocaciones a `git`, así que se cachean por ruta: sin
 * eso, cada render del panel dispararía tantos procesos como tabs abiertas. El árbol se
 * dibuja con lo que haya y se reacomoda solo cuando llegan las respuestas.
 */
export function useRepoInfo(cwds: string[]): Map<string, RepoInfo> {
  const [cache, setCache] = useState<Map<string, RepoInfo>>(() => new Map(shared));
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  /** Las carpetas que hay que volver a leer (sin dejar de mostrar lo que tienen). Lo que
   *  vino de `shared` arranca acá: se muestra ya, pero pudo cambiar desde que se leyó. */
  const stale = useRef(new Set(shared.keys()));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const invalidate = (root: string) => {
      let any = false;
      for (const [cwd, info] of cacheRef.current) {
        if (belongs(cwd, info, root)) {
          stale.current.add(cwd);
          any = true;
        }
      }
      if (any) setVersion((v) => v + 1);
    };
    invalidators.add(invalidate);
    return () => { invalidators.delete(invalidate); };
  }, []);

  // La clave es el CONTENIDO, no el array: `cwds` se rearma en cada render y comparar la
  // referencia relanzaría el efecto para siempre.
  const key = JSON.stringify([...new Set(cwds)].sort());

  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    const toRead = wanted.filter((cwd) => !cacheRef.current.has(cwd) || stale.current.has(cwd));
    if (toRead.length === 0) return;
    toRead.forEach((cwd) => stale.current.delete(cwd));

    let gone = false;
    let done = false;
    Promise.all(
      toRead.map((cwd) =>
        repoInfo(cwd)
          .then((info) => [cwd, info] as const)
          // Si git no contestó, se queda lo que ya se sabía. Solo una carpeta que nunca se
          // pudo leer (la borraron con la tab abierta) cae en "sin repo".
          .catch(() => [cwd, cacheRef.current.get(cwd) ?? UNRESOLVED] as const)
      )
    ).then((pairs) => {
      done = true;
      pairs.forEach(([cwd, info]) => shared.set(cwd, info));
      if (gone) return;
      setCache((prev) => mergeRepoInfo(prev, pairs));
    });

    return () => {
      gone = true;
      // Cortada a mitad de camino: lo que se iba a releer sigue pendiente.
      if (!done) toRead.forEach((cwd) => stale.current.add(cwd));
    };
  }, [key, version]);

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
