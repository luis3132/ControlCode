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
  /** Con qué complejidad se lanzó. `null` = se nombró el modelo (o se usó el de siempre). */
  complexity: Complexity | null;
  routedBy: RoutedBy | null;
  /** Qué se descartó al asignarla y por qué, una cosa por línea. */
  routeNote: string | null;
  /** `lead` reparte el objetivo; `worker` es una tarea de su plan. `null` = lanzada a mano. */
  role: TaskRole | null;
  /** El nombre corto con que el plan se refiere a ella (`api`, `tests`). */
  planKey: string | null;
  /** Quién la delegó. */
  parentId: string | null;
  depth: number;
  /** Va en su propio worktree (se crea cuando le toca correr). */
  isolate: boolean;
  resultSchema: string | null;
  /** Por qué falló el intento anterior. */
  lastError: string | null;
  /** Las tareas que tienen que terminar bien antes de que esta arranque. */
  dependsOn: string[];
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

/**
 * `handed_off` = el usuario la siguió en una terminal: el trabajo no se paró, se mudó.
 * `pending` = de un plan, esperando sus dependencias o lugar. `skipped` = no llegó a
 * correr: una dependencia no terminó bien o se acabó el presupuesto del run.
 */
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "cancelled" | "handed_off" | "skipped";

export type TaskRole = "lead" | "worker";

/** Un lote de tareas: una suelta, o un objetivo que un lead repartió. */
export interface Run {
  id: string;
  workspaceId: string;
  objective: string;
  cwd: string;
  status: "running" | "done" | "failed" | "cancelled";
  maxParallel: number;
  budgetUsd: number | null;
  spentUsd: number;
  createdAt: number;
  endedAt: number | null;
}

/** Algo que un agente del run les dejó escrito a los demás. */
export interface Fact {
  id: string;
  runId: string;
  taskId: string | null;
  /** El título de la tarea que lo escribió. `null` = una tab o el usuario. */
  author: string | null;
  kind: "decision" | "finding" | "file" | "constraint" | "note";
  body: string;
  createdAt: number;
}

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

// ── Ruteo ──────────────────────────────────────────────────────────

export type Complexity = "trivial" | "standard" | "hard";

/**
 * Con qué criterio se asignó: lo nombró quien la lanzó (`manual`), salió a la primera del
 * tramo (`policy`), o hubo que descartar algo por el camino (`fallback`).
 */
export type RoutedBy = "manual" | "policy" | "fallback";

export interface QuotaWindow {
  /** De 0 a 1. */
  utilization: number;
  /** Epoch en segundos. Pasado ese momento, la ventana ya se reinició. */
  resetsAt: number | null;
}

/** Lo último que informó una tarea sobre el cupo de su cuenta. */
export interface Quota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  rejected: boolean;
  rejectedUntil: number | null;
  overage: boolean;
  observedAt: number;
}

export interface RosterModel {
  /** Lo que recibe el flag de modelo de la TUI. */
  id: string;
  label: string;
  /** `false` = no puede trabajar como agente. `null` = no se sabe. */
  toolcall: boolean | null;
  local: boolean;
  /** USD por millón de tokens. */
  costIn: number | null;
  costOut: number | null;
  context: number | null;
  unavailable: string | null;
}

export interface RosterAccount {
  /** `null` = la del sistema. */
  accountId: string | null;
  key: string;
  name: string;
  label: string | null;
  loggedIn: boolean;
  quota: Quota | null;
  running: number;
}

export interface RosterAgent {
  agentId: string;
  label: string;
  installed: boolean;
  /** Se puede correr sin terminal. */
  launchable: boolean;
  unavailable: string | null;
  models: RosterModel[];
  accounts: RosterAccount[];
}

/** Qué se puede lanzar ahora. */
export interface Roster {
  agents: RosterAgent[];
}

export interface ModelRef {
  agentId: string;
  model: string;
}

/** Qué modelos probar para cada complejidad, en orden. */
export type Tiers = Record<Complexity, ModelRef[]>;

export interface Assignment {
  agentId: string;
  /** `null` = el de siempre de la TUI. */
  model: string | null;
  /** `null` = la del sistema. */
  accountId: string | null;
  routedBy: RoutedBy;
  notes: string[];
}
