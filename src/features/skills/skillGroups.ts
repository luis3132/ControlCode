/**
 * El catálogo instalado, agrupado y filtrado, sin React.
 *
 * Se agrupa por ORIGEN y no por nombre ni por categoría porque el origen es lo único que
 * distingue dos skills homónimas: `pdf-filler` de un repo y `pdf-filler` de otro son cosas
 * distintas que se llaman igual, y en una lista plana no hay forma de saber cuál es cuál.
 * Es el mismo corte que usa el Marketplace, así que las dos pantallas se leen igual.
 */
import type { SkillSummary } from "./types";

export interface InstalledSkillGroup {
  /** `null` = instaladas a mano desde un archivo, sin repo detrás. */
  registryId: string | null;
  registryName: string | null;
  items: SkillSummary[];
}

/**
 * Filtra por texto libre.
 *
 * El repo y el autor entran en la búsqueda: con skills homónimas de repos distintos,
 * escribir "anthropics" es la forma natural de quedarse con la que buscabas.
 */
export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter((s) => {
    const haystack = [
      s.name, s.description ?? "", s.categories.join(" "), s.registryName ?? "", s.author ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Agrupa por repo de origen.
 *
 * Las locales van al final: son las menos, y empezar por ellas dejaría lo que se instaló
 * del marketplace —que es casi todo— empujado hacia abajo.
 */
export function groupSkillsByOrigin(skills: SkillSummary[]): InstalledSkillGroup[] {
  const groups: InstalledSkillGroup[] = [];
  // La clave admite `null` — el grupo de las locales. Un centinela de texto tendría que
  // ser un valor que ningún id de repo pueda tomar, y no hay ninguno que lo garantice.
  const index = new Map<string | null, InstalledSkillGroup>();

  for (const skill of skills) {
    let group = index.get(skill.registryId);
    if (!group) {
      group = { registryId: skill.registryId, registryName: skill.registryName, items: [] };
      index.set(skill.registryId, group);
      groups.push(group);
    }
    group.items.push(skill);
  }

  for (const group of groups) {
    group.items.sort((a, b) => a.name.localeCompare(b.name));
  }

  return groups.sort((a, b) => {
    if ((a.registryId === null) !== (b.registryId === null)) return a.registryId === null ? 1 : -1;
    return (a.registryName ?? "").localeCompare(b.registryName ?? "");
  });
}

/** El orden en el que se recorren las filas con las flechas: el mismo en el que se dibujan. */
export function flatSkillOrder(groups: InstalledSkillGroup[]): SkillSummary[] {
  return groups.flatMap((g) => g.items);
}
