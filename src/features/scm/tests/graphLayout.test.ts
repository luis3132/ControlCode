import { describe, expect, it } from "vitest";

import { graphWidth, layoutGraph } from "../graphLayout";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutGraph", () => {
  it("una historia lineal es un solo carril", () => {
    const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    // El primer commit no tiene padres: no baja nada.
    expect(rows[2].bottom).toEqual([]);
    expect(graphWidth(rows)).toBe(1);
  });

  it("un merge abre un carril para la rama fusionada y lo cierra donde se separó", () => {
    //   m        merge de f en main
    //   |\
    //   | f
    //   b |      main siguió
    //   |/
    //   a
    const rows = layoutGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].bottom).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 0 }),
      expect.objectContaining({ from: 0, to: 1 }),
    ]));
    expect(rows[1].lane).toBe(1);
    // b sigue en el 0, y como los dos esperan a a, el carril de f converge ahí.
    expect(rows[2].lane).toBe(0);
    expect(rows[2].bottom).toEqual(expect.arrayContaining([expect.objectContaining({ from: 1, to: 0 })]));
    expect(rows[2].continuing.map((l) => l.lane)).toEqual([0]);
    expect(rows[3].lane).toBe(0);
    expect(rows[1].color).not.toBe(rows[0].color);
    expect(graphWidth(rows)).toBe(2);
  });

  it("dos puntas que salen del mismo commit usan dos carriles y el hueco se reusa", () => {
    // x y y son dos ramas desde a; después viene otra rama z.
    const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a"), c("z")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // Cuando llega a, el carril 1 converge al 0 y se cierra.
    expect(rows[2].continuing).toEqual([]);
  });

  it("la línea principal no salta de carril: converge la de la derecha", () => {
    // main: m2 -> m1 -> a ; feat: f -> a ; f aparece antes que m1.
    const rows = layoutGraph([c("m2", "m1"), c("f", "a"), c("m1", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[2].bottom).toEqual(expect.arrayContaining([expect.objectContaining({ from: 1, to: 0 })]));
  });

  it("una rama de la izquierda que espera el mismo padre recibe a la de la derecha", () => {
    // f (carril 1) llega a a cuando main (carril 0) ya lo espera.
    const rows = layoutGraph([c("m", "a"), c("f", "a"), c("a")]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].bottom).toEqual([expect.objectContaining({ from: 1, to: 0 }), expect.objectContaining({ from: 0, to: 0 })]);
  });
});
