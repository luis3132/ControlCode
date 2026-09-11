/**
 * Cómo se agrupa y se ordena la flota.
 *
 * Es lógica pura y va aparte del componente por lo mismo que `sessionTree.ts` y
 * `skillGroups.ts`: el orden es la parte que se puede equivocar en silencio —una tarjeta
 * que pide algo y queda enterrada abajo es un agente parado que nadie ve— y así se puede
 * probar sin montar nada.
 */
import type { Task, TaskStatus } from "./types";

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

/** Un estado terminal ya no cambia solo: no hace falta seguir refrescando su reloj. */
export function isLive(status: TaskStatus): boolean {
  return status === "ready" || status === "running";
}
