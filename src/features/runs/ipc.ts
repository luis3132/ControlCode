/** Comandos de los agentes headless. */
import { invoke } from "@tauri-apps/api/core";

import type { Assignment, Complexity, Fact, PendingApproval, PermissionRule, Roster, Run, Task, Tiers } from "./types";

export const listTasks = (workspaceId: string) =>
  invoke<Task[]>("run_list_tasks", { workspaceId });

export const listRuns = (workspaceId: string) =>
  invoke<Run[]>("run_list_runs", { workspaceId });

export const listFacts = (runId: string) => invoke<Fact[]>("run_list_facts", { runId });

/** Para un run entero: lo que espera no arranca y lo que corre se detiene. */
export const cancelRun = (runId: string) => invoke<void>("run_cancel_run", { runId });

export interface StartOrchestrationInput extends RouteInput {
  workspaceId: string;
  cwd: string;
  objective: string;
  /** Cuántas tareas del plan corren a la vez (1-6). */
  maxParallel: number;
  /** Ninguna tarea nueva arranca después de gastarlo. */
  budgetUsd?: number | null;
}

/** Lanza un lead: el agente que reparte el objetivo en tareas para otros agentes. */
export const startOrchestration = (input: StartOrchestrationInput) =>
  invoke<Task>("run_start_orchestration", {
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    objective: input.objective,
    maxParallel: input.maxParallel,
    budgetUsd: input.budgetUsd ?? null,
    ...routeArgs(input),
  });

/** A quién le toca: o se nombra el modelo, o se declara la complejidad y elige la app. */
export interface RouteInput {
  /** Obligatorio con `model`. Con solo `complexity`, lo elige el ruteo. */
  agentId?: string | null;
  model?: string | null;
  complexity?: Complexity | null;
  /** Con `autoAccount`, se ignora. `null` = la del sistema. */
  accountId?: string | null;
  /** Que la cuenta la elija el ruteo: con sesión, con cupo y la menos cargada. */
  autoAccount?: boolean;
}

export interface StartTaskInput extends RouteInput {
  workspaceId: string;
  cwd: string;
  title: string;
  prompt: string;
  budgetUsd?: number | null;
  /** En su propio worktree de git, en vez de sobre la carpeta del proyecto. */
  isolate?: boolean;
}

const routeArgs = (input: RouteInput) => ({
  agentId: input.agentId ?? null,
  model: input.model ?? null,
  complexity: input.complexity ?? null,
  accountId: input.accountId ?? null,
  autoAccount: input.autoAccount ?? false,
});

/** Asigna, crea y lanza. Si no hay a quién asignarla, falla con el motivo y no crea nada. */
export const startTask = (input: StartTaskInput) =>
  invoke<Task>("run_start_task", {
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    title: input.title,
    prompt: input.prompt,
    ...routeArgs(input),
    budgetUsd: input.budgetUsd ?? null,
    isolate: input.isolate ?? false,
  });

/** A quién le tocaría, sin lanzar nada. */
export const previewRoute = (input: RouteInput) =>
  invoke<Assignment>("run_preview_route", routeArgs(input));

/** Qué se puede lanzar ahora. `refresh` vuelve a sondear las TUIs. */
export const getRoster = (refresh = false) => invoke<Roster>("run_roster", { refresh });

export const getTiers = () => invoke<Tiers>("run_get_tiers");

/** Guarda los tramos. Se niega si alguno queda vacío. */
export const setTiers = (tiers: Tiers) => invoke<Tiers>("run_set_tiers", { tiers });

export const cancelTask = (taskId: string) => invoke<void>("run_cancel_task", { taskId });

/**
 * Deja la tarea lista para seguirla en una terminal. Si todavía corre, la para: dos
 * procesos escribiendo la misma sesión se pisarían el transcript.
 */
export const handOffTask = (taskId: string) => invoke<Task>("run_hand_off_task", { taskId });

export interface DiscardedWorktree {
  branch: string;
  /** La rama quedó porque tiene commits que no están en ningún otro lado. */
  branchKept: boolean;
}

/** Descarta el worktree de una tarea terminada. Se niega si hay cambios sin commitear. */
export const discardWorktree = (taskId: string) =>
  invoke<DiscardedWorktree>("run_discard_worktree", { taskId });

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
