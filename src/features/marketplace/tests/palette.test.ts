import { describe, expect, it } from "vitest";

import { flatOrder, groupByRegistry, keyOf, moveSelection, reconcileSelection } from "../palette";
import type { MarketplaceSkillEntry } from "../types";

const entry = (registryId: string, id: string, registryName = registryId): MarketplaceSkillEntry => ({
  id, registryId, registryName, name: id, author: null, description: null,
  categories: [], compatibleAgents: [], folderPath: id, files: [], installs: null,
});

describe("keyOf", () => {
  it("distingue dos entradas homónimas de repos distintos", () => {
    expect(keyOf(entry("a", "testing"))).not.toBe(keyOf(entry("b", "testing")));
  });
});

describe("groupByRegistry", () => {
  it("agrupa conservando el orden de llegada", () => {
    const skills = [entry("a", "1"), entry("b", "2"), entry("a", "3")];
    const groups = groupByRegistry(skills);
    expect(groups.map((g) => g.registryId)).toEqual(["a", "b"]);
    expect(groups[0].items.map((s) => s.id)).toEqual(["1", "3"]);
  });

  it("sin resultados no hay grupos", () => {
    expect(groupByRegistry([])).toEqual([]);
  });
});

describe("flatOrder", () => {
  it("recorre los grupos en orden, cruzando los encabezados", () => {
    const groups = groupByRegistry([entry("a", "1"), entry("b", "2"), entry("a", "3")]);
    expect(flatOrder(groups).map((s) => s.id)).toEqual(["1", "3", "2"]);
  });
});

describe("moveSelection", () => {
  const order = [entry("a", "1"), entry("a", "2"), entry("b", "3")];

  it("baja y sube", () => {
    expect(moveSelection(order, keyOf(order[0]), 1)).toBe(keyOf(order[1]));
    expect(moveSelection(order, keyOf(order[1]), -1)).toBe(keyOf(order[0]));
  });

  it("cruza de un grupo al siguiente", () => {
    expect(moveSelection(order, keyOf(order[1]), 1)).toBe(keyOf(order[2]));
  });

  it("se queda en los extremos en vez de dar la vuelta", () => {
    expect(moveSelection(order, keyOf(order[2]), 1)).toBe(keyOf(order[2]));
    expect(moveSelection(order, keyOf(order[0]), -1)).toBe(keyOf(order[0]));
  });

  it("sin nada marcado entra por la punta del sentido", () => {
    expect(moveSelection(order, null, 1)).toBe(keyOf(order[0]));
    expect(moveSelection(order, null, -1)).toBe(keyOf(order[2]));
  });

  it("sin resultados no hay nada que marcar", () => {
    expect(moveSelection([], null, 1)).toBeNull();
  });
});

describe("reconcileSelection", () => {
  it("respeta lo marcado si sigue en la lista", () => {
    const order = [entry("a", "1"), entry("a", "2")];
    expect(reconcileSelection(order, keyOf(order[1]))).toBe(keyOf(order[1]));
  });

  it("marca lo primero cuando lo anterior ya no está", () => {
    // Pasa con cada tecla del buscador: Enter no puede instalar algo que ya no se ve.
    const order = [entry("a", "9")];
    expect(reconcileSelection(order, "a::viejo")).toBe(keyOf(order[0]));
  });

  it("sin resultados no marca nada", () => {
    expect(reconcileSelection([], "a::1")).toBeNull();
  });
});
