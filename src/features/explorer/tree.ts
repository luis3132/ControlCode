/**
 * El árbol de archivos, sin React.
 *
 * El panel guarda dos cosas: qué directorios ya se leyeron (`loaded`) y cuáles están
 * abiertos (`expanded`). Todo lo que se dibuja sale de aplanar esas dos con las funciones
 * de acá, así que la lógica se puede probar sin montar nada.
 */
import type { DirEntry, FileMark, RepoInfo, TreeRow } from "./types";

/** Prioridad al pintar una carpeta: gana la marca más "fuerte" de lo que contiene. */
const SEVERITY: FileMark[] = ["U", "D", "A", "M", "?"];

/** Separador de rutas del sistema, deducido de la ruta misma. Windows usa `\`, y
 *  `git status` devuelve `/` siempre — de ahí que las relativas se normalicen. */
function sep(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/**
 * Ruta relativa al root del repo, en el formato que usa git (siempre con `/`).
 *
 * Devuelve `null` si la ruta cae fuera del root: un symlink de skill puede apuntar a
 * `~/.controlcode`, y marcarlo con el estado de un archivo homónimo del proyecto sería
 * peor que no marcarlo.
 */
export function relativeTo(root: string, path: string): string | null {
  const s = sep(root);
  const base = root.endsWith(s) ? root : root + s;
  if (!path.startsWith(base)) return path === root ? "" : null;
  return path.slice(base.length).split("\\").join("/");
}

/**
 * La marca que le toca a una ruta.
 *
 * Un archivo la lleva si está en `changes`. Una carpeta la hereda de lo que contiene —
 * si no, un cambio enterrado a cinco niveles sería invisible con el árbol plegado, que
 * es justamente cuando hace falta verlo.
 */
export function markForPath(repo: RepoInfo | null, entry: DirEntry): FileMark | null {
  if (!repo?.root) return null;
  const rel = relativeTo(repo.root, entry.path);
  if (rel === null) return null;

  if (!entry.isDir) return repo.changes[rel] ?? null;

  const prefix = rel === "" ? "" : rel + "/";
  let best: FileMark | null = null;
  for (const [changed, mark] of Object.entries(repo.changes)) {
    if (!changed.startsWith(prefix)) continue;
    if (best === null || SEVERITY.indexOf(mark) < SEVERITY.indexOf(best)) best = mark;
  }
  return best;
}

/**
 * Aplana el árbol a la lista de filas visibles.
 *
 * Solo baja por los directorios que están expandidos Y ya leídos: un expandido cuya
 * lectura todavía no volvió simplemente no aporta hijos, sin romper el resto.
 */
export function flattenTree(
  rootPath: string,
  loaded: Map<string, DirEntry[]>,
  expanded: Set<string>,
  repo: RepoInfo | null = null
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number, seen: Set<string>) => {
    // Un symlink que apunta a un ancestro haría bucle infinito. Pasa de verdad:
    // `.claude/skills/x` puede resolver a una carpeta que contiene al proyecto.
    if (seen.has(dir)) return;
    const children = loaded.get(dir);
    if (!children) return;

    for (const entry of children) {
      const isExpanded = entry.isDir && expanded.has(entry.path);
      rows.push({ entry, depth, isExpanded, mark: markForPath(repo, entry) });
      if (isExpanded) walk(entry.path, depth + 1, new Set([...seen, dir]));
    }
  };

  walk(rootPath, 0, new Set());
  return rows;
}

/** Abre o cierra un directorio, devolviendo un set nuevo (el store no muta). */
export function toggleExpanded(expanded: Set<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(path)) next.add(path);
  return next;
}
