/**
 * Cómo se muestra el ruteo: las piezas puras que usan el diálogo de lanzar y los tramos de
 * Ajustes. Sin React, para poder probarlas.
 */
import type { Assignment, Complexity, ModelRef, Quota, Roster, RosterAgent } from "./types";

export const COMPLEXITIES: Complexity[] = ["trivial", "standard", "hard"];

/**
 * El porcentaje de la ventana de 5 h que vale AHORA. `null` = nunca se supo.
 *
 * Una ventana que ya se reinició está en cero aunque el último dato diga 90 %: mostrar el
 * número viejo haría esquivar una cuenta que tiene la ventana entera libre.
 */
export function fiveHourPercent(quota: Quota | null, now: number): number | null {
  const w = quota?.fiveHour;
  if (!w) return null;
  if (w.resetsAt !== null && w.resetsAt <= now) return 0;
  return Math.round(w.utilization * 100);
}

/** Los agentes que se pueden correr sin terminal. */
export function launchableAgents(roster: Roster | null): RosterAgent[] {
  return roster?.agents.filter((a) => a.launchable) ?? [];
}

/** La asignación en palabras sueltas; el texto lo arma quien la muestra. */
export interface AssignmentView {
  agentLabel: string;
  model: string | null;
  /**
   * `null` = no hace falta nombrarla (una sola cuenta, o una TUI sin cuentas). `system` es la
   * principal: su nombre en el roster es el de la TUI, y "Claude Code · Sonnet · Claude
   * Code" no dice nada, así que la nombra quien la muestra.
   */
  account: { system: true } | { system: false; name: string } | null;
  percent: number | null;
}

export function describeAssignment(roster: Roster | null, a: Assignment, now: number): AssignmentView {
  const agent = roster?.agents.find((x) => x.agentId === a.agentId);
  const account = agent?.accounts.find((x) => x.accountId === a.accountId);
  const model = a.model === null ? null : (agent?.models.find((m) => m.id === a.model)?.label ?? a.model);
  return {
    agentLabel: agent?.label ?? a.agentId,
    model,
    // Con una sola cuenta no se nombra: no hay otra con la que confundirla.
    account: !account || (agent?.accounts.length ?? 0) <= 1
      ? null
      : account.accountId === null ? { system: true } : { system: false, name: account.name },
    percent: account ? fiveHourPercent(account.quota, now) : null,
  };
}

/** Clave estable de un modelo, para `Select` y para `key`. */
export const refKey = (ref: ModelRef) => `${ref.agentId}␟${ref.model}`;

export function parseRefKey(key: string): ModelRef | null {
  const [agentId, model] = key.split("␟");
  return agentId && model ? { agentId, model } : null;
}

/** El tramo con un modelo más al final. No se repite: dos veces el mismo no agrega nada. */
export function addToTier(list: ModelRef[], ref: ModelRef): ModelRef[] {
  return list.some((r) => refKey(r) === refKey(ref)) ? list : [...list, ref];
}

/** El tramo con ese modelo un lugar antes. */
export function moveEarlier(list: ModelRef[], index: number): ModelRef[] {
  if (index <= 0 || index >= list.length) return list;
  const next = [...list];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

/** El tramo sin ese modelo. Nunca vacío: un tramo sin modelos no tiene a quién asignar. */
export function removeFromTier(list: ModelRef[], index: number): ModelRef[] {
  if (list.length <= 1) return list;
  return list.filter((_, i) => i !== index);
}
