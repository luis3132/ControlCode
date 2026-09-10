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
