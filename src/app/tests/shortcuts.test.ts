import { describe, expect, it } from "vitest";

import {
  SHORTCUTS,
  matchShortcut,
  nextTabId,
  resolveGoto,
  shortcutForPath,
  type KeyChord,
} from "../shortcuts";

/** Un acorde con todo apagado, para que cada test encienda solo lo suyo. */
function chord(partial: Partial<KeyChord> & { key: string }): KeyChord {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

describe("matchShortcut", () => {
  it("reconoce los acordes de la tabla", () => {
    expect(matchShortcut(chord({ key: "m", ctrlKey: true }))?.action).toEqual({
      kind: "goto",
      path: "/marketplace",
    });
    expect(matchShortcut(chord({ key: "Tab", ctrlKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: 1,
    });
  });

  /// Shift distingue dos acordes que comparten tecla, así que tiene que compararse en los
  /// dos sentidos: exigirlo donde va y rechazarlo donde no.
  it("Shift elige entre ciclar hacia adelante y hacia atrás", () => {
    expect(matchShortcut(chord({ key: "Tab", ctrlKey: true, shiftKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: -1,
    });
    expect(matchShortcut(chord({ key: "m", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("sin Ctrl no hay atajo", () => {
    expect(matchShortcut(chord({ key: "m" }))).toBeNull();
  });

  /// AltGr llega como Ctrl+Alt en Windows y Linux: sin este rechazo, escribir un carácter
  /// con AltGr saltaría de sección en medio de una frase.
  it("Ctrl+Alt (AltGr) no dispara nada", () => {
    expect(matchShortcut(chord({ key: "e", ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("Meta no dispara nada (Cmd+M minimiza en macOS)", () => {
    expect(matchShortcut(chord({ key: "m", ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it("la tecla llega en mayúscula cuando hay Shift", () => {
    expect(matchShortcut(chord({ key: "TAB", ctrlKey: true, shiftKey: true }))?.action).toEqual({
      kind: "cycleTab",
      delta: -1,
    });
  });

  it("una tecla que no está en la tabla no matchea", () => {
    expect(matchShortcut(chord({ key: "z", ctrlKey: true }))).toBeNull();
  });
});

describe("la tabla de atajos", () => {
  /// Dos filas con el mismo acorde harían que la segunda fuera inalcanzable, y el síntoma
  /// sería "este atajo no hace nada" sin ninguna pista de por qué.
  it("no tiene acordes repetidos", () => {
    const chords = SHORTCUTS.map((s) => `${s.key}${s.shift ? "+shift" : ""}`);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("las teclas están en minúscula, que es como se comparan", () => {
    for (const s of SHORTCUTS) expect(s.key).toBe(s.key.toLowerCase());
  });
});

describe("resolveGoto", () => {
  it("lleva a la sección cuando estás en otra parte", () => {
    expect(resolveGoto("/marketplace", "/", true)).toBe("/marketplace");
  });

  it("estando ya en la sección, vuelve a la terminal", () => {
    expect(resolveGoto("/marketplace", "/marketplace", true)).toBe("/workspace");
  });

  /// Sin tabs, `/workspace` rebota a Home solo: el atajo no debe provocar ese parpadeo.
  it("sin tabs abiertas no hace nada en vez de rebotar", () => {
    expect(resolveGoto("/marketplace", "/marketplace", false)).toBeNull();
  });
});

describe("nextTabId", () => {
  const tabs = ["a", "b", "c"];

  it("avanza y retrocede", () => {
    expect(nextTabId(tabs, "a", 1)).toBe("b");
    expect(nextTabId(tabs, "b", -1)).toBe("a");
  });

  it("da la vuelta en los dos extremos", () => {
    expect(nextTabId(tabs, "c", 1)).toBe("a");
    expect(nextTabId(tabs, "a", -1)).toBe("c");
  });

  it("sin tabs no hay nada que activar", () => {
    expect(nextTabId([], "a", 1)).toBeNull();
  });

  it("con una sola tab se queda en ella", () => {
    expect(nextTabId(["a"], "a", 1)).toBe("a");
  });

  /// Puede no haber tab activa (una ventana recién restaurada, por ejemplo): se entra por
  /// la punta que corresponde al sentido, no siempre por la primera.
  it("sin tab activa entra por la punta del sentido", () => {
    expect(nextTabId(tabs, null, 1)).toBe("a");
    expect(nextTabId(tabs, null, -1)).toBe("c");
  });

  it("una tab activa que ya no existe se trata como si no hubiera ninguna", () => {
    expect(nextTabId(tabs, "borrada", 1)).toBe("a");
  });
});

describe("shortcutForPath", () => {
  it("encuentra el acorde de una sección", () => {
    expect(shortcutForPath("/settings")).toBe("Ctrl+G");
  });

  it("una ruta sin atajo devuelve null", () => {
    expect(shortcutForPath("/workspaces")).toBeNull();
  });
});
