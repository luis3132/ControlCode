/**
 * Comandos de ventana y de la app, los únicos que no pertenecen a ninguna feature.
 * Ver `window/manager.rs`.
 */
import { invoke } from "@tauri-apps/api/core";

export const homeDir = () => invoke<string>("get_home_dir");

export const windowLabels = () => invoke<string[]>("get_window_labels");

export const openNewWindow = (label: string) => invoke<void>("open_new_window", { label });

export const focusWindow = (label: string) => invoke<void>("focus_window", { label });

/**
 * Cierra ESTA ventana. Si quedan otras del mismo workspace, su fila se borra; si era la
 * última, se preserva para poder restaurar el workspace.
 */
export const closeAndForgetWindow = (label: string) =>
  invoke<void>("close_and_forget_window", { label });

/** Confirma la salida de la app entera tras el diálogo de "hay varias ventanas abiertas". */
export const confirmExitAll = () => invoke<void>("confirm_exit_all");

/** Emite un evento a TODAS las ventanas (incluida la que llama). */
export const broadcastEvent = (event: string, payload: string) =>
  invoke<void>("broadcast_event", { event, payload });

/** Posición del cursor en píxeles físicos — para saber sobre qué ventana se soltó una tab. */
export const cursorPosition = () => invoke<[number, number]>("get_cursor_position");

/** `label → [x, y, ancho, alto]` de cada ventana viva, en píxeles físicos. */
export const allWindowBounds = () =>
  invoke<Record<string, [number, number, number, number]>>("get_all_window_bounds");
