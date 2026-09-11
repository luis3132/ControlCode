/**
 * La lógica del buscador de skills, sin React.
 *
 * Agrupar por repositorio y moverse con las flechas son dos cosas que tienen que estar de
 * acuerdo: la flecha baja tiene que ir al siguiente resultado EN PANTALLA, cruzando los
 * encabezados de grupo. Por eso el orden plano se deriva de los mismos grupos que se
 * dibujan, y no de la lista original.
 */
import type { MarketplaceSkillEntry } from "./types";

export interface SkillGroup {
  registryId: string;
  registryName: string;
  items: MarketplaceSkillEntry[];
}

/** Identidad de una entrada. NUNCA el nombre: dos repos pueden publicar el mismo. */
export function keyOf(skill: Pick<MarketplaceSkillEntry, "registryId" | "id">): string {
  return `${skill.registryId}::${skill.id}`;
}

/**
 * Agrupa por repositorio conservando el orden en que llegaron.
 *
 * El backend ya ordena por prioridad de repo y relevancia; reordenar acá desharía eso.
 */
export function groupByRegistry(skills: MarketplaceSkillEntry[]): SkillGroup[] {
  const groups: SkillGroup[] = [];
  const index = new Map<string, SkillGroup>();

  for (const skill of skills) {
    let group = index.get(skill.registryId);
    if (!group) {
      group = { registryId: skill.registryId, registryName: skill.registryName, items: [] };
      index.set(skill.registryId, group);
      groups.push(group);
    }
    group.items.push(skill);
  }
  return groups;
}

/** El orden en el que se recorren los resultados con las flechas. */
export function flatOrder(groups: SkillGroup[]): MarketplaceSkillEntry[] {
  return groups.flatMap((g) => g.items);
}

/**
 * La entrada a marcar al mover la selección.
 *
 * No da la vuelta: en una lista de resultados, llegar al final y reaparecer arriba hace
 * perder de vista dónde estabas. Se queda en el extremo.
 */
export function moveSelection(
  order: MarketplaceSkillEntry[],
  current: string | null,
  delta: 1 | -1
): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.findIndex((s) => keyOf(s) === current);
  // Sin nada marcado se entra por la punta que corresponde al sentido.
  if (at === -1) return keyOf(delta > 0 ? order[0] : order[order.length - 1]);
  const next = Math.min(order.length - 1, Math.max(0, at + delta));
  return keyOf(order[next]);
}

/**
 * La selección que sobrevive a un cambio de resultados.
 *
 * Mientras se escribe, la lista se rehace en cada tecla. Si lo marcado sigue estando, se
 * respeta; si desapareció, se marca lo primero — dejar la selección apuntando a algo que
 * ya no se ve hace que Enter instale una skill que el usuario no tiene delante.
 */
export function reconcileSelection(
  order: MarketplaceSkillEntry[],
  current: string | null
): string | null {
  if (order.length === 0) return null;
  if (current !== null && order.some((s) => keyOf(s) === current)) return current;
  return keyOf(order[0]);
}
