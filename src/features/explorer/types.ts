/** Una entrada del árbol, tal como la devuelve `explorer_read_dir`. */
export interface DirEntry {
  name: string;
  /** Absoluta: es la identidad de la fila (para expandir y para cruzar con git). */
  path: string;
  isDir: boolean;
  isHidden: boolean;
}

/** Letra de `git status`, resumida a una sola columna. */
export type FileMark = "U" | "A" | "M" | "D" | "?";

export interface RepoInfo {
  /** `null` = la carpeta no está en ningún repo; el árbol se muestra sin marcas. */
  root: string | null;
  branch: string | null;
  /** Un worktree enlazado, no el checkout principal. */
  isWorktree: boolean;
  /** Ruta relativa al root → letra. */
  changes: Record<string, FileMark>;
  changedCount: number;
}

/** Una fila ya lista para dibujar: el árbol aplanado con su profundidad. */
export interface TreeRow {
  entry: DirEntry;
  depth: number;
  isExpanded: boolean;
  /** La marca de git que le corresponde, si tiene. */
  mark: FileMark | null;
}
