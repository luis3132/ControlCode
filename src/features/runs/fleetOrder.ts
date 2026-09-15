/**
 * Cómo se agrupa y se ordena la flota.
 *
 * Es lógica pura y va aparte del componente por lo mismo que `sessionTree.ts` y
 * `skillGroups.ts`: el orden es la parte que se puede equivocar en silencio —una tarjeta
 * que pide algo y queda enterrada abajo es un agente parado que nadie ve— y así se puede
 * probar sin montar nada.
 */
import type { PendingApproval, Run, Task, TaskStatus } from "./types";

/** Los tres estados que la consola distingue, y el orden en que se muestran. */
export type FleetGroup = "needsYou" | "running" | "idle";

export const FLEET_GROUPS: FleetGroup[] = ["needsYou", "running", "idle"];

/**
 * En qué grupo cae una tarjeta.
 *
 * Una tarea con un permiso esperando es `needsYou` aunque su estado siga siendo `running`:
 * desde afuera no está trabajando, está parada. Esa distinción es la que hace que la
 * consola sirva — un agente bloqueado que se ve igual que uno que avanza es un agente que
 * nadie destraba.
 */
export function groupOf(task: Task, blocked?: ReadonlySet<string>): FleetGroup {
  if (blocked?.has(task.id)) return "needsYou";
  switch (task.status) {
    case "running":
      return "running";
    case "ready":
      // Creada pero todavía sin proceso: para quien mira es lo mismo que arrancando.
      return "running";
    case "pending":
      // En cola de un plan: no terminó, va a arrancar sola. Es trabajo en curso del run.
      return "running";
    default:
      return "idle";
  }
}

export function countByGroup(
  tasks: Task[],
  blocked?: ReadonlySet<string>
): Record<FleetGroup, number> {
  const counts: Record<FleetGroup, number> = { needsYou: 0, running: 0, idle: 0 };
  for (const t of tasks) counts[groupOf(t, blocked)] += 1;
  return counts;
}

const GROUP_RANK: Record<FleetGroup, number> = { needsYou: 0, running: 1, idle: 2 };

/**
 * Ordena la flota: primero quien está trabado, después quien trabaja, al final quien ya
 * terminó.
 *
 * Dentro de "trabajando" va primero **el que arrancó hace más tiempo**, no el más nuevo:
 * un agente que lleva veinte minutos es el que más probablemente se colgó, y es a quien
 * conviene mirar. Dentro de "terminado" va primero el que cerró recién, que es lo último
 * que pasó y de lo que uno se quiere enterar.
 */
export function sortFleet(tasks: Task[], blocked?: ReadonlySet<string>): Task[] {
  return [...tasks].sort((a, b) => {
    const byGroup = GROUP_RANK[groupOf(a, blocked)] - GROUP_RANK[groupOf(b, blocked)];
    if (byGroup !== 0) return byGroup;

    if (groupOf(a, blocked) === "idle") {
      return (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt);
    }
    return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt);
  });
}

/** Las tarjetas que coinciden con el filtro de estado y con el texto del buscador. */
export function filterFleet(
  tasks: Task[],
  group: FleetGroup | null,
  query: string,
  blocked?: ReadonlySet<string>
): Task[] {
  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (group && groupOf(t, blocked) !== group) return false;
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      t.cwd.toLowerCase().includes(q) ||
      t.agentId.toLowerCase().includes(q)
    );
  });
}

/** Un estado terminal ya no cambia solo: no hace falta seguir refrescando su reloj. Una
 *  tarea en cola sí: va a arrancar sola cuando le toque. */
export function isLive(status: TaskStatus): boolean {
  return status === "pending" || status === "ready" || status === "running";
}

/** Tiene un proceso corriendo (o a punto): es lo que ocupa una cuenta y edita archivos. */
export function isActive(status: TaskStatus): boolean {
  return status === "ready" || status === "running";
}

export interface FleetSummary {
  running: number;
  /** Tarjetas de ESTE workspace con un permiso esperando. */
  needsYou: number;
  spentUsd: number;
}

/**
 * Lo que la barra de estado dice de la flota, siempre visible.
 *
 * Solo cuenta los pedidos de tareas que están en la lista, o sea las de este workspace. La
 * cola de permisos es de toda la app, pero la barra lleva a `/fleet`, y un número que
 * promete algo que al abrir la consola no aparece es peor que no mostrarlo.
 */
export function fleetSummary(tasks: Task[], approvals: PendingApproval[]): FleetSummary {
  const ids = new Set(tasks.map((t) => t.id));
  const blocked = new Set(approvals.filter((a) => ids.has(a.taskId)).map((a) => a.taskId));
  return {
    // Solo lo que tiene proceso: "3 en segundo plano" con dos esperando turno prometería
    // más trabajo del que hay.
    running: tasks.filter((t) => isActive(t.status) && !blocked.has(t.id)).length,
    needsYou: blocked.size,
    spentUsd: tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
  };
}

/**
 * Cuántos agentes están trabajando YA sobre la carpeta misma (no en un worktree suyo).
 *
 * Es el dato que decide si aislar el siguiente: uno solo en la carpeta no choca con nadie,
 * pero un segundo editaría los mismos archivos que el primero. Los que corren en su
 * worktree no cuentan, justamente porque no tocan la carpeta.
 */
export function liveInFolder(tasks: Task[], cwd: string): number {
  return tasks.filter((t) => isActive(t.status) && !t.worktreePath && t.cwd === cwd).length;
}

// ── Runs orquestados ─────────────────────────────────────────────

export interface RunSummary {
  run: Run;
  /** El agente que reparte. `null` = el plan lo declaró una tab. */
  lead: Task | null;
  /** Las tareas del plan, sin el lead. */
  total: number;
  done: number;
  /** Fallidas, salteadas o paradas: lo que no se va a cumplir. */
  broken: number;
  /** Corriendo o en cola. */
  active: number;
}

/**
 * Los runs que son un plan (tienen lead o tareas de un plan), con su avance. Una tarea
 * suelta también es un run por dentro, pero mostrarla como tal sería ruido: ya es su tarjeta.
 * Primero los que siguen andando, después el más nuevo.
 */
export function orchestratedRuns(runs: Run[], tasks: Task[]): RunSummary[] {
  return runs
    .map((run) => {
      const mine = tasks.filter((t) => t.runId === run.id);
      const lead = mine.find((t) => t.role === "lead") ?? null;
      const plan = mine.filter((t) => t.role === "worker");
      return {
        run,
        lead,
        total: plan.length,
        done: plan.filter((t) => t.status === "done").length,
        broken: plan.filter((t) => ["failed", "skipped", "cancelled"].includes(t.status)).length,
        active: plan.filter((t) => isLive(t.status)).length,
      };
    })
    .filter((s) => s.lead !== null || s.total > 0)
    .sort((a, b) => {
      const live = Number(b.run.status === "running") - Number(a.run.status === "running");
      return live !== 0 ? live : b.run.createdAt - a.run.createdAt;
    });
}

/** Las dependencias de una tarea que todavía no terminaron bien, por su key. */
export function waitingOn(task: Task, tasks: Task[]): string[] {
  return task.dependsOn
    .map((id) => tasks.find((t) => t.id === id))
    .filter((dep): dep is Task => !!dep && dep.status !== "done")
    .map((dep) => dep.planKey ?? dep.title);
}
