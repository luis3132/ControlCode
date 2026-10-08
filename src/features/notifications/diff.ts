import type { Subprocess } from "@/features/processes/types";
import type { PendingApproval } from "@/features/runs/types";

/** Lo que cambió entre dos estados de los stores que alimentan la campana. Sin efectos. */

type Busy = Record<string, boolean>;

/** Qué tabs tienen un turno en marcha (arrancando cuenta: ya se mandó algo). */
export function busyMap(chats: Record<string, { running: boolean; starting: boolean }>): Busy {
  const out: Busy = {};
  for (const [id, c] of Object.entries(chats)) out[id] = c.running || c.starting;
  return out;
}

/** Las tabs que estaban trabajando y ya no. */
export function finishedTurns(prev: Busy, next: Busy): string[] {
  return Object.keys(prev).filter((id) => prev[id] && next[id] === false);
}

/** Los permisos que no estaban antes. */
export function newApprovals(prev: PendingApproval[], next: PendingApproval[]): PendingApproval[] {
  const seen = new Set(prev.map((a) => a.id));
  return next.filter((a) => !seen.has(a.id));
}

/**
 * Los que estaban corriendo y salieron con error. Detenido por la persona (`stopped`) no es
 * un error, y salir con 0 tampoco: un build que termina bien no tiene por qué avisar.
 */
export function failedProcesses(prev: Subprocess[], next: Subprocess[]): Subprocess[] {
  const wasRunning = new Set(prev.filter((p) => p.status === "running").map((p) => p.id));
  return next.filter((p) => wasRunning.has(p.id) && p.status === "exited" && p.exitCode !== null && p.exitCode !== 0);
}
