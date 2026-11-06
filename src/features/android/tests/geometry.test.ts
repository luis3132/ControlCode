import { describe, expect, it } from "vitest";

import { fitInside, gesture, toDevice, wheelSwipe } from "../geometry";
import { specialKey, typedChar, untypeable } from "../keys";

describe("geometry", () => {
  it("encaja la pantalla en el espacio sin deformarla", () => {
    expect(fitInside({ width: 400, height: 400 }, { width: 1080, height: 2400 })).toEqual({ width: 180, height: 400 });
    expect(fitInside({ width: 0, height: 400 }, { width: 1080, height: 2400 })).toEqual({ width: 0, height: 0 });
  });

  it("lleva un punto de la imagen a píxeles del dispositivo", () => {
    const shown = { width: 270, height: 600 };
    const frame = { width: 1080, height: 2400 };
    expect(toDevice({ x: 135, y: 300 }, shown, frame)).toEqual({ x: 540, y: 1200 });
    expect(toDevice({ x: 0, y: 0 }, shown, frame)).toEqual({ x: 0, y: 0 });
    expect(toDevice({ x: 271, y: 10 }, shown, frame)).toBeNull();
  });

  it("distingue toque, toque largo y deslizar", () => {
    const a = { x: 100, y: 200 };
    expect(gesture(a, a, 2, 120)).toEqual({ kind: "tap", x: 100, y: 200 });
    expect(gesture(a, a, 3, 900)).toEqual({ kind: "hold", x: 100, y: 200, ms: 900 });
    expect(gesture(a, { x: 100, y: 900 }, 80, 250)).toEqual({ kind: "swipe", x: 100, y: 200, x2: 100, y2: 900, ms: 250 });
  });

  it("girar la rueda hacia abajo sube el dedo, sin salirse de la pantalla", () => {
    const frame = { width: 1080, height: 2400 };
    const down = wheelSwipe({ x: 500, y: 1200 }, 100, frame);
    expect(down?.kind).toBe("swipe");
    if (down?.kind !== "swipe") return;
    expect(down.y2).toBeLessThan(down.y);
    const up = wheelSwipe({ x: 500, y: 2390 }, -500, frame);
    if (up?.kind !== "swipe") throw new Error("esperaba un swipe");
    expect(up.y2).toBeGreaterThan(up.y);
    expect(up.y2).toBeLessThanOrEqual(2400);
    expect(wheelSwipe({ x: 1, y: 1 }, 0, frame)).toBeNull();
  });
});

describe("keys", () => {
  it("las teclas especiales son las del teléfono", () => {
    expect(specialKey("Escape")).toBe("back");
    expect(specialKey("Enter")).toBe("enter");
    expect(specialKey("a")).toBeNull();
  });

  it("solo escribe caracteres sueltos y no los atajos", () => {
    expect(typedChar({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe("a");
    expect(typedChar({ key: "c", ctrlKey: true, metaKey: false, altKey: false })).toBeNull();
    expect(typedChar({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });

  it("avisa qué no puede escribir adb", () => {
    expect(untypeable("hola señor ñ")).toEqual(["ñ"]);
    expect(untypeable("plain")).toEqual([]);
  });
});
