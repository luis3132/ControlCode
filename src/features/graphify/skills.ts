/**
 * Cómo se lee el estado de la skill de graphify, que es lo que cambia con el tiempo.
 *
 * La skill viaja DENTRO del paquete de PyPI: actualizar el paquete no actualiza la copia
 * que ya está en disco. Graphify avisa de eso a mitad de una sesión del agente ("your
 * installed graphify version is different from the skill file"); acá se puede decir antes,
 * comparando el sello `.graphify_version` de cada destino con lo que contesta
 * `graphify --version`.
 */
import type { GraphifyStatus, GraphifyTarget } from "./ipc";

/** En qué estado está la skill de un destino. */
export type SkillState =
  /** No hay ninguna skill en esa carpeta. */
  | "missing"
  /** Hay una, y es la del paquete que está instalado. */
  | "current"
  /** Hay una, pero la escribió otra versión del paquete: hay que volver a instalarla. */
  | "stale"
  /** Hay una, pero no se puede saber de cuándo (sin sello, o sin CLI para comparar). */
  | "unknown";

export function skillState(target: GraphifyTarget, status: GraphifyStatus | null): SkillState {
  if (!target.installedVersion) return "missing";
  // Sin CLI no hay con qué comparar: está instalada y no se sabe si quedó vieja. Decir
  // "al día" ahí sería afirmar algo que no se comprobó.
  if (!status?.version) return "unknown";
  return target.installedVersion === status.version ? "current" : "stale";
}

/** Un destino se identifica por su plataforma; la de por defecto no tiene nombre. */
export function targetKey(target: GraphifyTarget): string {
  return target.platform ?? "";
}

/**
 * Los destinos que le importan a esta instalación, con el que ya tiene la skill primero.
 *
 * Son seis y casi siempre interesa uno: el de la TUI que se usa. Ordenar por "acá ya hay
 * algo" hace que reinstalar después de actualizar el paquete —el caso repetido— no
 * obligue a buscar cuál era.
 */
export function orderedTargets(targets: GraphifyTarget[]): GraphifyTarget[] {
  return [...targets].sort((a, b) => Number(!!b.installedVersion) - Number(!!a.installedVersion));
}
