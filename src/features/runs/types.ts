/** Una tarjeta de la consola: un agente headless con su trabajo. */
export interface Task {
  id: string;
  runId: string;
  title: string;
  prompt: string;
  agentId: string;
  accountId: string | null;
  model: string | null;
  cwd: string;
  budgetUsd: number | null;
  status: TaskStatus;
  /** Lo fijó la app antes de lanzar; es con lo que se reabre como pane (`--resume`). */
  sessionId: string | null;
  attempt: number;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  eventsPath: string | null;
  /** La raíz del worktree en el que corre. `null` = corre en la carpeta del proyecto. */
  worktreePath: string | null;
  branch: string | null;
  /** Se descartó la carpeta del worktree. La rama puede seguir existiendo. */
  worktreeRemoved: boolean;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

/** `handed_off` = el usuario la siguió en una terminal: el trabajo no se paró, se mudó. */
export type TaskStatus = "ready" | "running" | "done" | "failed" | "cancelled" | "handed_off";

/** Lo que pasó en una tarea, ya traducido del dialecto de su TUI. */
export type AgentEvent =
  | { kind: "started"; sessionId: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; label: string }
  | { kind: "finished"; outcome: TaskOutcome };

export interface TaskOutcome {
  ok: boolean;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** El evento en vivo que emite el backend, con a qué tarjeta pertenece. */
export type TaskEventPayload = AgentEvent & { taskId: string };

/** Un permiso que un agente está esperando que le contesten. */
export interface PendingApproval {
  id: string;
  taskId: string;
  toolName: string;
  /** El `input` crudo de la herramienta. De acá sale el diff. */
  input: Record<string, unknown>;
  askedAt: number;
  /** La regla que dejaría escrita "recordar", tal cual. `null` = no se ofrece. */
  suggestedRule: string | null;
}

/** Lo que se decide sin preguntar en una carpeta. */
export interface PermissionRule {
  id: string;
  cwd: string;
  /** `Bash(git status*)`, `Read`, `Edit(src/**)`. */
  pattern: string;
  allow: boolean;
  createdAt: number;
}
