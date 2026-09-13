/** Comandos de los agentes headless. */
import { invoke } from "@tauri-apps/api/core";

import type { PendingApproval, PermissionRule, Task } from "./types";

export const listTasks = (workspaceId: string) =>
  invoke<Task[]>("run_list_tasks", { workspaceId });

export interface StartTaskInput {
  workspaceId: string;
  cwd: string;
  title: string;
  prompt: string;
  agentId: string;
  accountId?: string | null;
  model?: string | null;
  budgetUsd?: number | null;
}

export const startTask = (input: StartTaskInput) =>
  invoke<Task>("run_start_task", {
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    title: input.title,
    prompt: input.prompt,
    agentId: input.agentId,
    accountId: input.accountId ?? null,
    model: input.model ?? null,
    budgetUsd: input.budgetUsd ?? null,
  });

export const cancelTask = (taskId: string) => invoke<void>("run_cancel_task", { taskId });

/**
 * Deja la tarea lista para seguirla en una terminal. Si todavía corre, la para: dos
 * procesos escribiendo la misma sesión se pisarían el transcript.
 */
export const handOffTask = (taskId: string) => invoke<Task>("run_hand_off_task", { taskId });

export const listApprovals = () => invoke<PendingApproval[]>("run_pending_approvals");

/**
 * Contesta un permiso. Con `remember`, además deja escrita su regla exacta para la carpeta.
 * `false` = el pedido ya no existe (venció, se canceló la tarea o ya estaba resuelto).
 */
export const decideApproval = (approvalId: string, allow: boolean, remember: boolean) =>
  invoke<boolean>("run_decide_approval", { approvalId, allow, remember });

export const listRules = (cwd: string) => invoke<PermissionRule[]>("run_list_rules", { cwd });

export const addRule = (cwd: string, pattern: string, allow: boolean) =>
  invoke<PermissionRule>("run_add_rule", { cwd, pattern, allow });

export const deleteRule = (id: string) => invoke<boolean>("run_delete_rule", { id });
