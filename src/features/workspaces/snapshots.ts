import { invoke } from "@tauri-apps/api/core";

import type { PrelaunchStep } from "@/features/prelaunch/types";

/** Una tab tal como estaba al cerrar el workspace. */
export interface SnapshotTab {
  title: string;
  titleIsCustom?: boolean | null;
  agentId: string;
  agentLabel: string;
  command: string;
  /** La conversación que tenía: sin esto, reabrir da una en blanco. */
  sessionId?: string | null;
  accountId?: string | null;
  prelaunch: PrelaunchStep[];
  /** Las skills que tenía adjuntas. Se pierden al cerrar la tab, así que se guardan. */
  skillIds: string[];
}

export interface WorkspaceSnapshot {
  cwd: string;
  workspaceId: string;
  tabs: SnapshotTab[];
  closedAt: number;
}

export const saveWorkspaceSnapshot = (cwd: string, workspaceId: string, tabs: SnapshotTab[]) =>
  invoke<void>("save_workspace_snapshot", { cwd, workspaceId, tabs });

export const listWorkspaceSnapshots = () =>
  invoke<WorkspaceSnapshot[]>("list_workspace_snapshots");

/** Lo devuelve y lo borra: reabrir un workspace consume su recuerdo. */
export const takeWorkspaceSnapshot = (cwd: string) =>
  invoke<WorkspaceSnapshot | null>("take_workspace_snapshot", { cwd });

export const forgetWorkspaceSnapshot = (cwd: string) =>
  invoke<void>("forget_workspace_snapshot", { cwd });
