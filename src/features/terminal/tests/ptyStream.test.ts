import { describe, expect, it } from "vitest";

import { dueForHibernation } from "../hibernation";
import { afterSnapshot } from "../ptyStream";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("afterSnapshot", () => {
  it("descarta lo que ya venía en la copia y deja pasar lo nuevo", () => {
    expect(afterSnapshot({ data: "abc", end: 10 }, 10)).toBe("");
    expect(afterSnapshot({ data: "abc", end: 13 }, 10)).toBe("abc");
  });

  it("de un tramo partido por la copia escribe solo la parte nueva, aun con multibyte", () => {
    const data = "ñandú✓";
    const end = 100;
    const start = end - bytes(data);
    // La copia tenía "ñan" (4 bytes).
    expect(afterSnapshot({ data, end }, start + bytes("ñan"))).toBe("dú✓");
  });
});

describe("dueForHibernation", () => {
  const hidden = new Map([["a", 0], ["b", 9 * 60_000], ["c", 0]]);
  it("hiberna las ocultas desde hace más de N minutos, una sola vez", () => {
    expect(dueForHibernation(hidden, 10 * 60_000, 10, new Set(["c"]))).toEqual(["a"]);
  });
  it("con 0 minutos no hiberna nunca", () => {
    expect(dueForHibernation(hidden, 99 * 60_000, 0, new Set())).toEqual([]);
  });
});
