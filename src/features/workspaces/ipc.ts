/** Comandos de workspaces. Ver `database/queries/workspaces.rs` y `window/manager.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { WorkspaceSummary } from "./types";

export const listWorkspaces = () => invoke<WorkspaceSummary[]>("db_list_workspaces");

export const saveWorkspace = (name: string, sourceWorkspaceId: string) =>
  invoke<{ id: string; name: string }>("db_save_workspace", { name, sourceWorkspaceId });

export const renameWorkspace = (workspaceId: string, name: string) =>
  invoke<void>("db_rename_workspace", { workspaceId, name });

export const deleteWorkspace = (workspaceId: string) =>
  invoke<void>("db_delete_workspace", { workspaceId });

export const openWorkspace = (workspaceId: string, closeCurrent: boolean) =>
  invoke<void>("open_workspace", { workspaceId, closeCurrent });

/** Vacía el bucket `default` y abre una ventana en blanco ahí. */
export const resetDefaultWorkspace = () => invoke<void>("reset_default_workspace");

/** Si el bucket `default` tiene tabs sin guardar — "Nuevo workspace" avisa antes. */
export const defaultWorkspaceHasContent = () => invoke<boolean>("default_workspace_has_content");

/** Ventanas VIVAS del workspace (`is_open = 1`). */
export const openWindowsOf = (workspaceId: string) =>
  invoke<{ label: string }[]>("db_get_workspace_windows", { workspaceId });

export const closeWorkspaceWindows = (workspaceId: string) =>
  invoke<void>("close_workspace_windows", { workspaceId });

export const liveWindowCount = (workspaceId: string) =>
  invoke<number>("live_workspace_window_count", { workspaceId });

export const getWorkspace = (workspaceId: string) =>
  invoke<{ id: string; name: string }>("db_get_workspace", { workspaceId });
