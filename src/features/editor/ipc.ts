/** Leer y guardar archivos para las tabs. Ver `explorer/files.rs`. */
import { invoke } from "@tauri-apps/api/core";

export type FileContent =
  | { kind: "text"; content: string; mtime: number; size: number }
  | { kind: "image"; dataUrl: string; mtime: number; size: number }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

export type WriteOutcome = { kind: "saved"; mtime: number } | { kind: "conflict"; mtime: number };

export const readFile = (path: string) => invoke<FileContent>("explorer_read_file", { path });

/** `expectedMtime: null` = sobrescribir sin mirar (el usuario lo eligió). */
export const writeFile = (path: string, content: string, expectedMtime: number | null) =>
  invoke<WriteOutcome>("explorer_write_file", { path, content, expectedMtime });

/** `null` = el archivo ya no existe. */
export const fileStat = (path: string) =>
  invoke<{ mtime: number; size: number } | null>("explorer_file_stat", { path });
