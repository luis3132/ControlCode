import { invoke } from "@tauri-apps/api/core";

import type { DirEntry, RepoInfo } from "./types";

/** Un solo nivel. El panel expande a demanda: leer recursivo un repo con
 *  `node_modules` tarda segundos y devuelve megabytes que nadie mira. */
export function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("explorer_read_dir", { path });
}

export function repoInfo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("explorer_repo_info", { path });
}

/** Lo que vigila el panel de esta ventana: las carpetas abiertas (cada una sin recursión)
 *  y el directorio de git. Rust avisa con `explorer-changed`. Vacío = dejar de vigilar. */
export function watchDirs(dirs: string[], gitDir: string | null): Promise<void> {
  return invoke<void>("explorer_watch", { dirs, gitDir });
}

/** Una tanda de cambios en las carpetas vigiladas. */
export interface ExplorerChanged {
  /** La ventana cuyo panel los pidió: el evento llega a todas. */
  window: string;
  dirs: string[];
  git: boolean;
}

/** Cada una devuelve la ruta que quedó: copiar o crear sobre un nombre ocupado no pisa,
 *  y la ruta final solo la sabe Rust. */
export const createFile = (dir: string, name: string) => invoke<string>("explorer_create_file", { dir, name });
export const createDir = (dir: string, name: string) => invoke<string>("explorer_create_dir", { dir, name });
export const renamePath = (path: string, name: string) => invoke<string>("explorer_rename", { path, name });
export const copyPath = (path: string, dir: string) => invoke<string>("explorer_copy", { path, dir });
export const movePath = (path: string, dir: string) => invoke<string>("explorer_move", { path, dir });
/** A la papelera del sistema, no borrado definitivo. */
export const trashPaths = (paths: string[]) => invoke<void>("explorer_trash", { paths });
