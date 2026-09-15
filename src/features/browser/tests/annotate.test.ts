import { describe, expect, it } from "vitest";

import { arrowWings, cropFor, isLight, placePaper, rectBetween, smoothSegments, toImagePoint } from "../annotate/geometry";
import {
  addShape, clearShapes, drawShape, EMPTY_HISTORY, redo, undo, type Ctx, type Shape,
} from "../annotate/shapes";

describe("recortar la página de la foto de la app", () => {
  const viewport = { width: 1000, height: 800 };

  it("con la foto al doble de resolución, el recorte también va al doble", () => {
    const page = { left: 300, top: 88, width: 700, height: 712 };
    const crop = cropFor(page, page, viewport, { width: 2000, height: 1600 });
    expect(crop).toEqual({
      source: { left: 600, top: 176, width: 1400, height: 1424 },
      screen: page,
    });
  });

  it("solo lo que se ve: un iframe más grande que su columna se recorta a la columna", () => {
    const page = { left: 300, top: 88, width: 1200, height: 900 };
    const column = { left: 300, top: 88, width: 600, height: 500 };
    const crop = cropFor(page, column, viewport, { width: 1000, height: 800 });
    expect(crop?.screen).toEqual(column);
    expect(crop?.source).toEqual(column);
  });

  it("nada visible, nada que recortar", () => {
    expect(cropFor({ left: 2000, top: 0, width: 100, height: 100 }, { left: 2000, top: 0, width: 100, height: 100 }, viewport, viewport))
      .toBeNull();
  });

  it("con escala fraccionaria no se sale de la foto por redondeo", () => {
    const page = { left: 0, top: 0, width: 1000, height: 800 };
    const crop = cropFor(page, page, viewport, { width: 1250, height: 1000 });
    expect(crop?.source).toEqual({ left: 0, top: 0, width: 1250, height: 1000 });
  });
});

describe("dónde se muestra la página congelada", () => {
  it("si la columna no cambió, exactamente donde estaba", () => {
    expect(placePaper({ width: 600, height: 400 }, { x: 20, y: 10 }, { width: 640, height: 420 }))
      .toEqual({ left: 20, top: 10, width: 600, height: 400 });
  });

  it("si ya no entra, achicada y centrada sin deformarse", () => {
    const box = placePaper({ width: 800, height: 400 }, { x: 0, y: 0 }, { width: 400, height: 400 });
    expect(box).toEqual({ left: 0, top: 100, width: 400, height: 200 });
  });

  it("un punto de la pantalla cae en su píxel de la captura aunque se muestre achicada", () => {
    const paper = { left: 100, top: 50, width: 400, height: 200 };
    expect(toImagePoint({ x: 300, y: 150 }, paper, { width: 1600, height: 800 })).toEqual({ x: 800, y: 400 });
  });
});

describe("formas", () => {
  it("un rectángulo arrastrado hacia arriba a la izquierda sigue siendo el mismo", () => {
    expect(rectBetween({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({ left: 10, top: 5, width: 40, height: 35 });
  });

  it("la punta de la flecha es simétrica y no más larga que media flecha", () => {
    const [a, b] = arrowWings({ x: 0, y: 0 }, { x: 20, y: 0 }, 8);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(-b.y);
    expect(20 - a.x).toBeLessThanOrEqual(10.01);
  });

  it("el trazo a mano se une por los puntos medios y termina en el último punto", () => {
    const path = smoothSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }]);
    expect(path?.segments.map((s) => s.end)).toEqual([{ x: 15, y: 5 }, { x: 20, y: 10 }]);
    expect(smoothSegments([{ x: 1, y: 1 }])?.segments).toEqual([]);
  });

  it("el borde del texto contrasta con su color", () => {
    expect(isLight("#facc15")).toBe(true);
    expect(isLight("#111827")).toBe(false);
  });
});

describe("deshacer y rehacer", () => {
  const pen = (x: number): Shape => ({ kind: "pen", color: "#ef4444", width: 4, points: [{ x, y: x }] });

  it("deshace de a una forma y rehace en el mismo orden", () => {
    let h = addShape(addShape(EMPTY_HISTORY, pen(1)), pen(2));
    h = undo(h);
    expect(h.present).toEqual([pen(1)]);
    h = redo(h);
    expect(h.present).toEqual([pen(1), pen(2)]);
    // Dibujar algo nuevo después de deshacer descarta lo que se podía rehacer.
    h = addShape(undo(h), pen(3));
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("borrar todo también se deshace", () => {
    let h = clearShapes(addShape(EMPTY_HISTORY, pen(1)));
    expect(h.present).toEqual([]);
    h = undo(h);
    expect(h.present).toEqual([pen(1)]);
  });

  it("un click con la flecha o un texto vacío no ensucian el historial", () => {
    const h = addShape(EMPTY_HISTORY, { kind: "arrow", color: "#fff", width: 4, from: { x: 5, y: 5 }, to: { x: 6, y: 6 } });
    expect(h).toBe(EMPTY_HISTORY);
    expect(addShape(EMPTY_HISTORY, { kind: "text", color: "#fff", size: 18, at: { x: 0, y: 0 }, text: "  " })).toBe(EMPTY_HISTORY);
  });
});

describe("pintar", () => {
  function recorder() {
    const calls: string[] = [];
    const state = { strokeStyle: "", fillStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter", globalAlpha: 1, font: "", textBaseline: "alphabetic" };
    const record = (name: string) => (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => (typeof a === "number" ? Math.round(a) : a)).join(",")})`);
    };
    const ctx = new Proxy(state, {
      get: (target, key: string) => (key in target ? target[key as keyof typeof target] : record(key)),
      set: (target, key: string, value) => {
        (target as Record<string, unknown>)[key] = value;
        if (key === "globalAlpha" || key === "lineWidth") calls.push(`${key}=${value}`);
        return true;
      },
    }) as unknown as Ctx;
    return { ctx, calls };
  }

  it("el resaltador pinta transparente y más ancho que el lápiz", () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, { kind: "marker", color: "#facc15", width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    expect(calls).toContain("globalAlpha=0.35");
    expect(calls).toContain("lineWidth=16");
    expect(calls[calls.length - 1]).toBe("restore()");
  });

  it("un click con el lápiz deja un punto", () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, { kind: "pen", color: "#ef4444", width: 6, points: [{ x: 5, y: 5 }] });
    expect(calls.some((c) => c.startsWith("arc(5,5,3"))).toBe(true);
  });

  it("el texto de varias líneas va una debajo de otra, con borde", () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, { kind: "text", color: "#ef4444", size: 20, at: { x: 10, y: 10 }, text: "hola\nchau" });
    expect(calls.filter((c) => c.startsWith("fillText"))).toEqual(["fillText(hola,10,10)", "fillText(chau,10,35)"]);
    expect(calls.filter((c) => c.startsWith("strokeText"))).toHaveLength(2);
  });
});
