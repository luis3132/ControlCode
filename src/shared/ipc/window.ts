/**
 * Comandos de ventana y de la app, los únicos que no pertenecen a ninguna feature.
 * Ver `window/manager.rs`.
 */
import { invoke } from "@tauri-apps/api/core";

export const homeDir = () => invoke<string>("get_home_dir");

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
