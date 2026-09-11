/** Comandos de los agentes headless. */
import { invoke } from "@tauri-apps/api/core";

import type { PendingApproval, Task } from "./types";

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

export const listApprovals = () => invoke<PendingApproval[]>("run_pending_approvals");

/** Contesta un permiso. `false` = el pedido ya no existe (venció o se canceló la tarea). */
export const decideApproval = (approvalId: string, allow: boolean, reason?: string) =>
  invoke<boolean>("run_decide_approval", { approvalId, allow, reason: reason ?? null });
