import { describe, expect, it } from "vitest";

import { clampZoom, TERMINAL_FONT_SIZE, TERMINAL_ZOOM, terminalFontSize } from "../theme";

describe("zoom del texto de la terminal", () => {
  it("al 100 % es el tamaño de siempre", () => {
    expect(terminalFontSize(TERMINAL_ZOOM.default)).toBe(TERMINAL_FONT_SIZE);
  });

  it("cada paso da un tamaño entero y distinto del anterior", () => {
    const sizes: number[] = [];
    for (let zoom = TERMINAL_ZOOM.min; zoom <= TERMINAL_ZOOM.max; zoom += TERMINAL_ZOOM.step) {
      sizes.push(terminalFontSize(zoom));
    }
    expect(sizes.every(Number.isInteger)).toBe(true);
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("lo que viene de afuera se lleva al rango y a un paso", () => {
    expect(clampZoom(10)).toBe(TERMINAL_ZOOM.min);
    expect(clampZoom(999)).toBe(TERMINAL_ZOOM.max);
    expect(clampZoom(123)).toBe(120);
    expect(clampZoom(Number("basura"))).toBe(TERMINAL_ZOOM.default);
  });
});
