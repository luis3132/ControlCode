import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { registerCapabilityResponders } from "../terminalCapabilities";

/** Parser de mentira: guarda los handlers registrados para poder dispararlos a mano. */
function fakeTerminal(kittyKeyboard = false) {
  const csi: Array<{ id: Record<string, unknown>; fn: (p: number[]) => boolean }> = [];
  const osc: Array<{ code: number; fn: (data: string) => boolean }> = [];
  const dcs: Array<{ id: Record<string, unknown>; fn: () => boolean }> = [];
  let disposed = 0;
  const dispose = () => ({ dispose: () => { disposed += 1; } });

  const term = {
    options: { vtExtensions: { kittyKeyboard } },
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
    csi,
    osc,
    csiWith: (match: Record<string, unknown>) =>
      csi.find((h) => Object.entries(match).every(([k, v]) => h.id[k] === v))?.fn,
    dcsHandler: () => dcs[0].fn,
    disposedCount: () => disposed,
    registered: () => csi.length + osc.length + dcs.length,
  };
}

function setup(kittyKeyboard = false) {
  const fake = fakeTerminal(kittyKeyboard);
  const sent: string[] = [];
  const unregister = registerCapabilityResponders(fake.term, (d) => sent.push(d));
  return { ...fake, sent, unregister };
}

describe("registerCapabilityResponders", () => {
  /// Desde xterm 6.1 estas las contesta xterm con el estado real. Interceptarlas pisaba esa
  /// respuesta: un "no conozco el modo 2026" deja a la TUI sin salida sincronizada, y
  /// redibuja parpadeando.
  it("no intercepta lo que xterm ya contesta bien: DECRQM, XTVERSION ni los colores", () => {
    const { csiWith, osc } = setup();
    expect(csiWith({ intermediates: "$", final: "p" })).toBeUndefined();
    expect(csiWith({ prefix: ">", final: "q" })).toBeUndefined();
    expect(osc).toHaveLength(0);
  });

  /// Con el protocolo apagado xterm no contesta nada, y sin respuesta la TUI se cuelga.
  it("con el teclado de Kitty apagado, contesta que no lo soporta", () => {
    const { csiWith, sent } = setup(false);
    expect(csiWith({ prefix: "?", final: "u" })!([])).toBe(true);
    expect(sent).toEqual(["\x1b[?0u"]);
  });

  it("con el teclado de Kitty encendido, deja que conteste xterm", () => {
    const { csiWith, sent } = setup(true);
    expect(csiWith({ prefix: "?", final: "u" })!([])).toBe(false);
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
