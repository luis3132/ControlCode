import { describe, expect, it } from "vitest";

import type { SkillSummary } from "@/features/skills/types";
import {
  filterSkills,
  flatSkillOrder,
  groupSkillsByOrigin,
} from "@/features/skills/skillGroups";

function skill(over: Partial<SkillSummary> & { name: string }): SkillSummary {
  return {
    id: `${over.registryId ?? "local"}:${over.name}`,
    description: null,
    version: "1.0.0",
    categories: [],
    compatibleAgents: [],
    compatibleVersions: {},
    author: null,
    license: null,
    homepage: null,
    sourcePath: `/skills/${over.name}`,
    registryId: null,
    originSkillId: null,
    registryName: null,
    installedAt: 0,
    updatedAt: 0,
    usedBy: [],
    ...over,
  };
}

describe("groupSkillsByOrigin", () => {
  it("separa dos skills homónimas de repos distintos", () => {
    // Es el caso que justifica agrupar por origen: en una lista plana son indistinguibles.
    const groups = groupSkillsByOrigin([
      skill({ name: "pdf-filler", registryId: "r1", registryName: "anthropics" }),
      skill({ name: "pdf-filler", registryId: "r2", registryName: "comunidad" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.registryName)).toEqual(["anthropics", "comunidad"]);
    expect(groups.every((g) => g.items.length === 1)).toBe(true);
  });

  it("las locales van al final, después de todos los repos", () => {
    const groups = groupSkillsByOrigin([
      skill({ name: "mia" }),
      skill({ name: "zeta", registryId: "r1", registryName: "zeta-repo" }),
      skill({ name: "alfa", registryId: "r2", registryName: "alfa-repo" }),
    ]);

    expect(groups.map((g) => g.registryName)).toEqual(["alfa-repo", "zeta-repo", null]);
    expect(groups[2].registryId).toBeNull();
  });

  it("dentro de un repo ordena por nombre", () => {
    const [group] = groupSkillsByOrigin([
      skill({ name: "zorro", registryId: "r", registryName: "repo" }),
      skill({ name: "ancla", registryId: "r", registryName: "repo" }),
    ]);
    expect(group.items.map((s) => s.name)).toEqual(["ancla", "zorro"]);
  });

  it("el orden plano coincide con el orden dibujado", () => {
    const groups = groupSkillsByOrigin([
      skill({ name: "b", registryId: "r", registryName: "repo" }),
      skill({ name: "a", registryId: "r", registryName: "repo" }),
      skill({ name: "local" }),
    ]);
    const drawn = groups.flatMap((g) => g.items.map((s) => s.id));
    expect(flatSkillOrder(groups).map((s) => s.id)).toEqual(drawn);
  });
});

describe("filterSkills", () => {
  const catalog = [
    skill({ name: "pdf-filler", registryName: "anthropics", registryId: "r1" }),
    skill({ name: "docx", description: "Edita documentos de Word", author: "luis" }),
    skill({ name: "otra", categories: ["pdf"] }),
  ];

  it("sin texto devuelve todo tal cual", () => {
    expect(filterSkills(catalog, "   ")).toBe(catalog);
  });

  it("busca en el repo, el autor, la descripción y las categorías", () => {
    expect(filterSkills(catalog, "anthropics").map((s) => s.name)).toEqual(["pdf-filler"]);
    expect(filterSkills(catalog, "luis").map((s) => s.name)).toEqual(["docx"]);
    expect(filterSkills(catalog, "word").map((s) => s.name)).toEqual(["docx"]);
    // "pdf" está en el nombre de una y en las categorías de otra: salen las dos.
    expect(filterSkills(catalog, "pdf").map((s) => s.name)).toEqual(["pdf-filler", "otra"]);
  });
});
