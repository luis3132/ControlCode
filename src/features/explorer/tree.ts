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
 * Las marcas de un repo, listas para consultar: la de cada archivo y la que hereda cada
 * carpeta de lo que contiene.
 *
 * Se arma una vez por cada respuesta de git y no por fila: calcular la de una carpeta
 * recorriendo todos los cambios costaba (carpetas visibles × archivos cambiados) en cada
 * dibujo, y con un `node_modules` abierto y cientos de cambios el panel se arrastraba.
 */
export interface MarkIndex {
  root: string | null;
  files: Record<string, FileMark>;
  /** Ruta relativa de carpeta (`""` = el root) → la marca más fuerte de adentro. */
  dirs: Map<string, FileMark>;
}

const stronger = (a: FileMark | undefined, b: FileMark): FileMark =>
  a === undefined || SEVERITY.indexOf(b) < SEVERITY.indexOf(a) ? b : a;

export function buildMarkIndex(repo: RepoInfo | null): MarkIndex {
  const dirs = new Map<string, FileMark>();
  if (!repo?.root) return { root: null, files: {}, dirs };
  for (const [changed, mark] of Object.entries(repo.changes)) {
    // Cada carpeta que la contiene, del root hacia abajo. Un untracked de carpeta llega
    // como `dir/`: la barra final no agrega un nivel vacío.
    const parts = changed.replace(/\/$/, "").split("/");
    let prefix = "";
    dirs.set("", stronger(dirs.get(""), mark));
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      dirs.set(prefix, stronger(dirs.get(prefix), mark));
    }
    // La carpeta untracked misma también lleva su marca.
    if (changed.endsWith("/")) dirs.set(changed.slice(0, -1), stronger(dirs.get(changed.slice(0, -1)), mark));
  }
  return { root: repo.root, files: repo.changes, dirs };
}

/**
 * La marca que le toca a una ruta.
 *
 * Un archivo la lleva si está en `changes`. Una carpeta la hereda de lo que contiene —
 * si no, un cambio enterrado a cinco niveles sería invisible con el árbol plegado, que
 * es justamente cuando hace falta verlo.
 */
export function markFor(index: MarkIndex, entry: DirEntry): FileMark | null {
  if (!index.root) return null;
  const rel = relativeTo(index.root, entry.path);
  if (rel === null) return null;
  if (!entry.isDir) return index.files[rel] ?? null;
  return index.dirs.get(rel) ?? null;
}

/** Lo mismo sin índice armado, para una consulta suelta. */
export function markForPath(repo: RepoInfo | null, entry: DirEntry): FileMark | null {
  return markFor(buildMarkIndex(repo), entry);
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
  repo: RepoInfo | MarkIndex | null = null
): TreeRow[] {
  const index = repo && "files" in repo ? repo : buildMarkIndex(repo);
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number, seen: Set<string>) => {
    // Un symlink que apunta a un ancestro haría bucle infinito. Pasa de verdad:
    // `.claude/skills/x` puede resolver a una carpeta que contiene al proyecto.
    if (seen.has(dir)) return;
    const children = loaded.get(dir);
    if (!children) return;

    for (const entry of children) {
      const isExpanded = entry.isDir && expanded.has(entry.path);
      rows.push({ entry, depth, isExpanded, mark: markFor(index, entry) });
      if (isExpanded) {
        seen.add(dir);
        walk(entry.path, depth + 1, seen);
        seen.delete(dir);
      }
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

/** Las filas que hay que dibujar para una lista de `count` filas de `rowHeight` px, con
 *  `overscan` de más arriba y abajo para que desplazar rápido no muestre huecos. */
export function visibleWindow(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight: number,
  overscan = 12
): { start: number; end: number } {
  if (count === 0 || viewport <= 0) return { start: 0, end: Math.min(count, overscan * 2) };
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(viewport / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
  };
}
