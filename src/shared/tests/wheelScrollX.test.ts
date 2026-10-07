import { describe, expect, it } from "vitest";

import { horizontalDelta } from "../wheelScrollX";

const overflowing = { scrollWidth: 1200, clientWidth: 600 };

describe("horizontalDelta", () => {
  it("la rueda vertical corre la tira en horizontal", () => {
    expect(horizontalDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, overflowing)).toBe(100);
    expect(horizontalDelta({ deltaX: 0, deltaY: -40, deltaMode: 0 }, overflowing)).toBe(-40);
  });

  it("convierte líneas y páginas a px", () => {
    expect(horizontalDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, overflowing)).toBe(48);
    expect(horizontalDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, overflowing)).toBe(600);
  });

  it("no toca un gesto horizontal del trackpad", () => {
    expect(horizontalDelta({ deltaX: 30, deltaY: 5, deltaMode: 0 }, overflowing)).toBeNull();
  });

  it("no hace nada si la tira no desborda o el giro es nulo", () => {
    expect(horizontalDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, { scrollWidth: 600, clientWidth: 600 })).toBeNull();
    expect(horizontalDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, overflowing)).toBeNull();
  });
});
