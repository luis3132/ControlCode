import { describe, expect, it } from "vitest";

import { isNoop, stripSlot, zoneAt, zoneBox } from "../layout/dropTarget";

describe("dónde cae una tab", () => {
  it("cerca de un borde divide hacia ese lado; en el medio, se muda", () => {
    expect(zoneAt(0.05, 0.5)).toBe("left");
    expect(zoneAt(0.95, 0.5)).toBe("right");
    expect(zoneAt(0.5, 0.1)).toBe("up");
    expect(zoneAt(0.5, 0.9)).toBe("down");
    expect(zoneAt(0.5, 0.5)).toBe("center");
    // En una esquina gana el borde más cercano.
    expect(zoneAt(0.1, 0.02)).toBe("up");
  });

  it("pinta la mitad hacia donde se va a dividir", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(zoneBox(box, "right")).toEqual({ left: 300, top: 50, width: 200, height: 200 });
    expect(zoneBox(box, "down")).toEqual({ left: 100, top: 150, width: 400, height: 100 });
    expect(zoneBox(box, "center")).toBe(box);
  });

  it("en una tira entra antes de la tab cuya mitad está a la derecha", () => {
    const tabs = [{ left: 0, width: 100 }, { left: 100, width: 100 }];
    expect(stripSlot(20, tabs)).toEqual({ index: 0, lineX: 0 });
    expect(stripSlot(60, tabs)).toEqual({ index: 1, lineX: 100 });
    expect(stripSlot(190, tabs)).toEqual({ index: 2, lineX: 200 });
    expect(stripSlot(30, [])).toEqual({ index: 0, lineX: 30 });
  });

  it("soltar en el propio grupo sin nada que dividir no hace nada", () => {
    expect(isNoop("center", true, 3)).toBe(true);
    expect(isNoop("right", true, 1)).toBe(true);
    expect(isNoop("right", true, 2)).toBe(false);
    expect(isNoop("center", false, 1)).toBe(false);
  });
});
