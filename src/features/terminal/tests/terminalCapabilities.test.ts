import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { registerCapabilityResponders, toXParseColor } from "../terminalCapabilities";

describe("toXParseColor", () => {
  it("traduce #rrggbb al formato que espera OSC 10/11", () => {
    expect(toXParseColor("#0d1117")).toBe("rgb:0d0d/1111/1717");
    expect(toXParseColor("0d1117")).toBe("rgb:0d0d/1111/1717");
    expect(toXParseColor("#FFFFFF")).toBe("rgb:ffff/ffff/ffff");
  });

  /// Un color mal formado no puede tumbar la respuesta: la TUI está ESPERANDO una, y no
  /// contestar la deja colgada (que es el bug que motivó todo este módulo).
  it("un color inválido degrada a negro en vez de romper", () => {
    expect(toXParseColor("#fff")).toBe("rgb:0000/0000/0000");
    expect(toXParseColor("")).toBe("rgb:0000/0000/0000");
  });
});

/** Parser de mentira: guarda los handlers registrados para poder dispararlos a mano. */
function fakeTerminal() {
  const csi: Array<{ id: Record<string, unknown>; fn: (p: number[]) => boolean }> = [];
  const osc: Array<{ code: number; fn: (data: string) => boolean }> = [];
  const dcs: Array<{ id: Record<string, unknown>; fn: () => boolean }> = [];
  let disposed = 0;
  const dispose = () => ({ dispose: () => { disposed += 1; } });

  const term = {
    parser: {
      registerCsiHandler: (id: Record<string, unknown>, fn: (p: number[]) => boolean) => {
        csi.push({ id, fn });
        return dispose();
      },
      registerOscHandler: (code: number, fn: (data: string) => boolean) => {
        osc.push({ code, fn });
        return dispose();
      },
      registerDcsHandler: (id: Record<string, unknown>, fn: () => boolean) => {
        dcs.push({ id, fn });
        return dispose();
      },
    },
  } as unknown as Terminal;

  return {
    term,
    csiWith: (match: Record<string, unknown>) =>
      csi.find((h) => Object.entries(match).every(([k, v]) => h.id[k] === v))!.fn,
    oscWith: (code: number) => osc.find((h) => h.code === code)!.fn,
    dcsHandler: () => dcs[0].fn,
    disposedCount: () => disposed,
    registered: () => csi.length + osc.length + dcs.length,
  };
}

function setup() {
  const fake = fakeTerminal();
  const sent: string[] = [];
  const unregister = registerCapabilityResponders(fake.term, (d) => sent.push(d), {
    foreground: "#e6edf3",
    background: "#0d1117",
  });
  return { ...fake, sent, unregister };
}

describe("registerCapabilityResponders", () => {
  /// Lo que importa es CONTESTAR: sin respuesta, OpenCode dibuja su logo, pasa a la
  /// pantalla alternativa y se queda mudo para siempre — una terminal negra.
  it("responde DECRQM con 'no conozco ese modo', sea cual sea", () => {
    const { csiWith, sent } = setup();
    const decrqm = csiWith({ intermediates: "$", final: "p" });

    expect(decrqm([2026])).toBe(true);
    expect(decrqm([2031])).toBe(true);
    expect(sent).toEqual(["\x1b[?2026;0$y", "\x1b[?2031;0$y"]);
  });

  it("responde XTVERSION solo a la forma `CSI > 0 q`", () => {
    const { csiWith, sent } = setup();
    const xtversion = csiWith({ prefix: ">", final: "q" });

    expect(xtversion([0])).toBe(true);
    expect(sent).toEqual(["\x1bP>|xterm.js\x1b\\"]);

    // Otros valores son DECSCUSR (forma del cursor): los maneja xterm.js, no nosotros.
    expect(xtversion([2])).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("declara que no soporta el protocolo de teclado de Kitty", () => {
    const { csiWith, sent } = setup();
    expect(csiWith({ prefix: "?", final: "u" })([])).toBe(true);
    expect(sent).toEqual(["\x1b[?0u"]);
  });

  it("contesta los colores reales del tema en OSC 10/11", () => {
    const { oscWith, sent } = setup();
    expect(oscWith(10)("?")).toBe(true);
    expect(oscWith(11)("?")).toBe(true);
    expect(sent).toEqual([
      "\x1b]10;rgb:e6e6/eded/f3f3\x1b\\",
      "\x1b]11;rgb:0d0d/1111/1717\x1b\\",
    ]);
  });

  /// Solo se intercepta la CONSULTA (`?`). La forma de asignación sigue siendo de
  /// xterm.js: si la tomáramos, cambiar el color de fondo desde la TUI dejaría de andar.
  it("no intercepta la asignación de color, solo la consulta", () => {
    const { oscWith, sent } = setup();
    expect(oscWith(11)("#ff0000")).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("responde XTGETTCAP con 'no tengo esa capacidad'", () => {
    const { dcsHandler, sent } = setup();
    expect(dcsHandler()()).toBe(true);
    expect(sent).toEqual(["\x1bP0+q\x1b\\"]);
  });

  it("desregistrar suelta todos los handlers", () => {
    const { unregister, registered, disposedCount } = setup();
    unregister();
    expect(disposedCount()).toBe(registered());
  });
});
