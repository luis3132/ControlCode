/**
 * La lógica del buscador de skills, sin React.
 *
 * Agrupar por repositorio y moverse con las flechas son dos cosas que tienen que estar de
 * acuerdo: la flecha baja tiene que ir al siguiente resultado EN PANTALLA, cruzando los
 * encabezados de grupo. Por eso el orden plano se deriva de los mismos grupos que se
 * dibujan, y no de la lista original.
 */
import type { MarketplaceSkillEntry } from "./types";

export { moveSelection, reconcileSelection } from "@/shared/ui/paletteNav";

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


